import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKafkaExporter,
  createNatsExporter,
  createStreamDispatcher,
  normalizeStreamEvent,
} from "../src/stream-exporters.js";
import { resolveStreamExportersConfig } from "../src/config.js";
import { openLedgerStore } from "../src/store/sqlite.js";

describe("Stream exporters configuration", () => {
  it("resolves default configuration with exporters disabled", () => {
    const config = resolveStreamExportersConfig({});
    assert.equal(config.kafka.enabled, false);
    assert.equal(config.kafka.brokers[0], "localhost:9092");
    assert.equal(config.kafka.topicPrefix, "accord.events");
    assert.equal(config.nats.enabled, false);
    assert.equal(config.nats.servers[0], "nats://localhost:4222");
    assert.equal(config.nats.subjectPrefix, "accord.events");
  });

  it("applies environment overrides for Kafka and NATS", () => {
    const config = resolveStreamExportersConfig({
      KAFKA_EXPORTER_ENABLED: "true",
      KAFKA_BROKERS: "kafka-1:9092,kafka-2:9092",
      KAFKA_TOPIC_PREFIX: "custom.accord",
      NATS_EXPORTER_ENABLED: "true",
      NATS_SERVERS: "nats://cluster:4222",
      NATS_SUBJECT_PREFIX: "custom.nats",
    });
    assert.equal(config.kafka.enabled, true);
    assert.deepEqual(config.kafka.brokers, ["kafka-1:9092", "kafka-2:9092"]);
    assert.equal(config.kafka.topicPrefix, "custom.accord");
    assert.equal(config.nats.enabled, true);
    assert.deepEqual(config.nats.servers, ["nats://cluster:4222"]);
    assert.equal(config.nats.subjectPrefix, "custom.nats");
  });
});

describe("Kafka exporter", () => {
  it("normalizes events and publishes to partitioned topics", async () => {
    const sent = [];
    const mockClient = {
      connect: async () => {},
      send: async (payload) => {
        sent.push(payload);
      },
      disconnect: async () => {},
    };

    const exporter = createKafkaExporter({
      topicPrefix: "accord.events",
      clientImpl: mockClient,
    });

    await exporter.connect();
    assert.equal(exporter.isConnected(), true);

    const event = {
      eventId: "10:tx1:0",
      dedupeKey: "10:tx1:0",
      topic: "created",
      ledger: 10,
      transactionHash: "tx1",
      payload: { id: 1 },
    };

    const published = await exporter.publish(event);
    assert.equal(published, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic, "accord.events.created");
    assert.equal(sent[0].messages[0].key, "10:tx1:0");

    // Deduplication check: re-publishing with same dedupeKey is ignored
    const duplicatePublished = await exporter.publish(event);
    assert.equal(duplicatePublished, false);
    assert.equal(sent.length, 1);

    await exporter.close();
    assert.equal(exporter.isConnected(), false);
  });

  it("replays historic events from store safely", async () => {
    const store = openLedgerStore(":memory:");
    await store.recordAccordEvent({
      eventId: "1:txA:0",
      dedupeKey: "1:txA:0",
      topic: "created",
      ledger: 1,
      occurredAt: "2026-03-01T00:00:00Z",
      payload: { id: 1 },
      schemaVersion: 1,
    });

    const sent = [];
    const exporter = createKafkaExporter({
      clientImpl: {
        connect: async () => {},
        send: async (msg) => sent.push(msg),
      },
    });

    await exporter.connect();
    const count = await exporter.replayFrom(store, 0);
    assert.equal(count, 1);
    assert.equal(sent.length, 1);

    await exporter.close();
    await store.close();
  });
});

describe("NATS exporter", () => {
  it("publishes normalized events to structured subjects", async () => {
    const published = [];
    const mockClient = {
      connect: async () => {},
      publish: async (subject, data) => {
        published.push({ subject, data: JSON.parse(data) });
      },
      close: async () => {},
    };

    const exporter = createNatsExporter({
      subjectPrefix: "accord.events",
      clientImpl: mockClient,
    });

    await exporter.connect();
    assert.equal(exporter.isConnected(), true);

    const event = {
      eventId: "20:tx2:0",
      dedupeKey: "20:tx2:0",
      topic: "approved",
      ledger: 20,
      payload: { id: 1 },
    };

    const ok = await exporter.publish(event);
    assert.equal(ok, true);
    assert.equal(published.length, 1);
    assert.equal(published[0].subject, "accord.events.approved");
    assert.equal(published[0].data.eventId, "20:tx2:0");

    // Deduplication check
    const dup = await exporter.publish(event);
    assert.equal(dup, false);
    assert.equal(published.length, 1);

    await exporter.close();
  });
});

describe("StreamDispatcher", () => {
  it("fans out events to all enabled exporters", async () => {
    const kafkaSent = [];
    const natsPublished = [];

    const dispatcher = createStreamDispatcher({
      config: {
        kafka: { enabled: true, brokers: ["localhost:9092"], topicPrefix: "test" },
        nats: { enabled: true, servers: ["localhost:4222"], subjectPrefix: "test" },
      },
      kafkaImpl: {
        connect: async () => {},
        send: async (m) => kafkaSent.push(m),
        disconnect: async () => {},
      },
      natsImpl: {
        connect: async () => {},
        publish: async (s, d) => natsPublished.push({ s, d }),
        close: async () => {},
      },
    });

    await dispatcher.start();

    await dispatcher.publish({
      eventId: "30:tx3:0",
      dedupeKey: "30:tx3:0",
      topic: "rpay",
      ledger: 30,
    });

    assert.equal(kafkaSent.length, 1);
    assert.equal(natsPublished.length, 1);

    await dispatcher.close();
  });
});

import type { Owner, Proposal, RecurringSchedule } from "../types/accord";

export type SearchResultGroup = "proposals" | "owners" | "recipients";

export type SearchResult = {
  id: string;
  group: SearchResultGroup;
  title: string;
  subtitle: string;
  /** In-app destination path. */
  to: string;
  /** Fields that matched the query (for tests / highlighting). */
  matchedOn: string[];
};

export type SearchIndex = {
  proposals: Proposal[];
  owners: Owner[];
  /** Recipient addresses drawn from proposals and recurring schedules. */
  recipients: Array<{ address: string; source: string; href: string }>;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function includesQuery(haystack: string, query: string): boolean {
  return normalize(haystack).includes(query);
}

/**
 * Build a searchable recipient list from proposals + recurring schedules.
 */
export function buildRecipientIndex(
  proposals: Proposal[],
  schedules: RecurringSchedule[] = [],
): SearchIndex["recipients"] {
  const seen = new Map<string, SearchIndex["recipients"][number]>();

  for (const proposal of proposals) {
    if (!proposal.to) continue;
    const key = normalize(proposal.to);
    if (!seen.has(key)) {
      seen.set(key, {
        address: proposal.to,
        source: `Proposal #${proposal.id}`,
        href: `/app/proposals/${proposal.id}`,
      });
    }
  }

  for (const schedule of schedules) {
    if (!schedule.recipient) continue;
    const key = normalize(schedule.recipient);
    if (!seen.has(key)) {
      seen.set(key, {
        address: schedule.recipient,
        source: `Schedule #${schedule.id}`,
        href: `/app/recurring`,
      });
    }
  }

  return [...seen.values()];
}

/**
 * Match proposals, owners, and recipients by description, address, or id.
 * Results are grouped and capped per group for the header dropdown.
 */
export function searchGlobal(
  query: string,
  index: SearchIndex,
  limitPerGroup = 5,
): SearchResult[] {
  const q = normalize(query);
  if (!q) return [];

  const results: SearchResult[] = [];

  const proposalHits: SearchResult[] = [];
  for (const proposal of index.proposals) {
    const matchedOn: string[] = [];
    if (includesQuery(String(proposal.id), q)) matchedOn.push("id");
    if (includesQuery(proposal.description ?? "", q)) matchedOn.push("description");
    if (includesQuery(proposal.to ?? "", q)) matchedOn.push("address");
    if (includesQuery(proposal.proposer ?? "", q)) matchedOn.push("proposer");
    if (includesQuery(proposal.kind ?? "", q)) matchedOn.push("kind");
    if (matchedOn.length === 0) continue;
    proposalHits.push({
      id: `proposal-${proposal.id}`,
      group: "proposals",
      title: `Proposal #${proposal.id}`,
      subtitle: proposal.description || proposal.kind,
      to: `/app/proposals/${proposal.id}`,
      matchedOn,
    });
    if (proposalHits.length >= limitPerGroup) break;
  }
  results.push(...proposalHits);

  const ownerHits: SearchResult[] = [];
  for (const owner of index.owners) {
    const matchedOn: string[] = [];
    if (includesQuery(owner.address, q)) matchedOn.push("address");
    if (includesQuery(owner.label ?? "", q)) matchedOn.push("label");
    if (matchedOn.length === 0) continue;
    ownerHits.push({
      id: `owner-${owner.address}`,
      group: "owners",
      title: owner.label || owner.address,
      subtitle: owner.address,
      to: `/app/owners`,
      matchedOn,
    });
    if (ownerHits.length >= limitPerGroup) break;
  }
  results.push(...ownerHits);

  const recipientHits: SearchResult[] = [];
  for (const recipient of index.recipients) {
    const matchedOn: string[] = [];
    if (includesQuery(recipient.address, q)) matchedOn.push("address");
    if (includesQuery(recipient.source, q)) matchedOn.push("source");
    if (matchedOn.length === 0) continue;
    recipientHits.push({
      id: `recipient-${recipient.address}`,
      group: "recipients",
      title: recipient.address,
      subtitle: recipient.source,
      to: recipient.href,
      matchedOn,
    });
    if (recipientHits.length >= limitPerGroup) break;
  }
  results.push(...recipientHits);

  return results;
}

export function groupSearchResults(
  results: SearchResult[],
): Record<SearchResultGroup, SearchResult[]> {
  return {
    proposals: results.filter((r) => r.group === "proposals"),
    owners: results.filter((r) => r.group === "owners"),
    recipients: results.filter((r) => r.group === "recipients"),
  };
}

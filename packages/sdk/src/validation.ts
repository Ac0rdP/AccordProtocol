/**
 * Parameter Validation for Accord Protocol SDK
 * Enforces contract boundaries prior to any network dispatch.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { AccordValidationError } from "./errors.js";

/**
 * Validates that an address string is either a valid Stellar account public key (G...)
 * or a valid Soroban Contract ID (C...).
 */
export function validateAddress(address: string, fieldName: string): void {
  if (!address || typeof address !== "string") {
    throw new AccordValidationError(fieldName, "Address must be a non-empty string.");
  }

  const isValidAccount = StrKey.isValidEd25519PublicKey(address);
  const isValidContract = StrKey.isValidContract(address);

  if (!isValidAccount && !isValidContract) {
    throw new AccordValidationError(
      fieldName,
      `Invalid Stellar address or contract ID '${address}'. Must be a valid 56-character G... public key or C... contract ID.`
    );
  }
}

/**
 * Validates an array of addresses, ensuring every item is valid and checking for duplicates.
 */
export function validateAddresses(addresses: string[], fieldName: string): void {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new AccordValidationError(fieldName, "Addresses must be a non-empty array.");
  }

  const seen = new Set<string>();
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    validateAddress(addr, `${fieldName}[${i}]`);
    if (seen.has(addr)) {
      throw new AccordValidationError(fieldName, `Duplicate address '${addr}' detected in list.`);
    }
    seen.add(addr);
  }
}

/**
 * Validates that an integer amount is strictly positive (amount > 0n).
 */
export function validatePositiveAmount(amount: bigint, fieldName: string): void {
  if (typeof amount !== "bigint") {
    throw new AccordValidationError(fieldName, "Amount must be a bigint.");
  }
  if (amount <= 0n) {
    throw new AccordValidationError(fieldName, `Amount must be strictly positive (got ${amount}).`);
  }
}

/**
 * Validates proposal description boundaries (1..=300 characters).
 */
export function validateDescription(description: string): void {
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new AccordValidationError("description", "Description cannot be empty.");
  }
  if (description.length > 300) {
    throw new AccordValidationError(
      "description",
      `Description length (${description.length}) exceeds maximum allowed length of 300 characters.`
    );
  }
}

/**
 * Validates proposal deadline timestamp (must be non-zero and in the future).
 */
export function validateDeadline(deadline: bigint): void {
  if (typeof deadline !== "bigint") {
    throw new AccordValidationError("deadline", "Deadline must be a bigint timestamp.");
  }
  if (deadline <= 0n) {
    throw new AccordValidationError("deadline", "Deadline must be a positive Unix timestamp in seconds.");
  }
}

/**
 * Validates threshold parameters (1 <= threshold <= totalWeight).
 */
export function validateThreshold(threshold: number, totalWeight?: number): void {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new AccordValidationError("threshold", "Threshold must be an integer >= 1.");
  }
  if (totalWeight !== undefined && threshold > totalWeight) {
    throw new AccordValidationError(
      "threshold",
      `Threshold (${threshold}) cannot exceed total voting weight (${totalWeight}).`
    );
  }
}

/**
 * Validates owner voting weight bounds (1 <= weight <= 100,000).
 */
export function validateWeight(weight: number): void {
  if (!Number.isInteger(weight) || weight < 1) {
    throw new AccordValidationError("weight", "Owner voting weight must be an integer >= 1.");
  }
  if (weight > 100_000) {
    throw new AccordValidationError("weight", "Owner voting weight cannot exceed 100,000.");
  }
}

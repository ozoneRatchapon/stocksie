// blake3 hashing helpers for the Stocksie frontend.
//
// The on-chain program never stores raw item / receipt / reason / name text —
// only 32-byte blake3 digests (see programs/stocksie/src/constants.rs
// `HASH_LEN`). Every instruction argument shaped as `[u8; 32]` is produced
// here so the UI never has to reason about serialization by hand.

import { blake3 } from '@noble/hashes/blake3';

const textEncoder = new TextEncoder();

/**
 * Compute a 32-byte blake3 digest of a UTF-8 string or raw byte array.
 *
 * Mirrors the on-chain `HASH_LEN` constant exactly (default blake3 output is
 * 32 bytes), so digests generated client-side are byte-identical to anything
 * the program would compare against.
 */
export function blake3Hash(input: string | Uint8Array): Uint8Array {
  const data = typeof input === 'string' ? textEncoder.encode(input) : input;
  return blake3(data);
}

/** Lowercase hex encoding of a byte array, no `0x` prefix. Buffer-free. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Convenience: blake3 digest of `input` rendered as lowercase hex. */
export function blake3HashHex(input: string | Uint8Array): string {
  return toHex(blake3Hash(input));
}

/**
 * blake3 digest of `input` as a plain `number[]` of length 32.
 *
 * The Anchor TS client encodes a `[u8; 32]` instruction argument from a
 * `number[]` (or `Uint8Array`); returning a mutable array here lets callers
 * pass it straight into `program.methods.<ix>(...)` without an extra cast.
 */
export function toHash32(input: string | Uint8Array): number[] {
  return Array.from(blake3Hash(input));
}

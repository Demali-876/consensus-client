import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertProxyProfileRequestV1,
  hashProxyProfileV1,
  normalizeProxyProfileV1,
  type ProxyExecutionProfileV1,
} from '../src/profile-v1.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'vectors/profile-v1.vectors.json'), 'utf8')) as {
  vectors: Array<{ input: unknown; normalized: ProxyExecutionProfileV1; hash: string }>;
};

describe('profile-v1 shared contract', () => {
  test('matches every canonicalization and hash vector', () => {
    for (const vector of fixture.vectors) {
      expect(normalizeProxyProfileV1(vector.input)).toEqual(vector.normalized);
      expect(hashProxyProfileV1(vector.input)).toBe(vector.hash);
    }
  });

  test('enforces origin, base path, allowed path, and method', () => {
    const profile = fixture.vectors[0].normalized;
    expect(() => assertProxyProfileRequestV1(profile, 'https://api.example.com/v1/products/1', 'GET')).not.toThrow();
    expect(() => assertProxyProfileRequestV1(profile, 'https://evil.example/v1/products/1', 'GET')).toThrow(/origin/);
    expect(() => assertProxyProfileRequestV1(profile, 'https://api.example.com/admin', 'GET')).toThrow(/base path/);
    expect(() => assertProxyProfileRequestV1(profile, 'https://api.example.com/v1/private', 'GET')).toThrow(/not allowed/);
    expect(() => assertProxyProfileRequestV1(profile, 'https://api.example.com/v1/products', 'POST')).toThrow(/method POST/);
  });
});

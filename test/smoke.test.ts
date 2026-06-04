import { describe, expect, it } from 'vitest';

import * as penstock from '../src/index';

describe('penstock package', () => {
  it('exposes an importable entry module', () => {
    expect(penstock).toBeTypeOf('object');
  });
});

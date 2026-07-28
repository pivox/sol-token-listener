import type { MetadataResolution } from '../domain/pumpfun-observation.js';

export interface MetadataProvider {
  readonly resolve: (uri: string) => Promise<MetadataResolution>;
}

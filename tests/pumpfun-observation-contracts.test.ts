import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePublicTokenMetadata,
} from '../src/domain/pumpfun-observation.js';

void test('normalise les métadonnées publiques Pump.fun sans inventer de valeur', () => {
  const metadata = normalizePublicTokenMetadata({
    name: ' Éclair ',
    symbol: ' ecl ',
    description: '  lancement public ',
    image: 'https://cdn.example/image.png',
    animation_url: 'https://cdn.example/video.mp4',
    external_url: 'https://example.org',
    twitter: 'https://x.com/eclair',
    telegram: 'https://t.me/eclair',
  });

  assert.deepEqual(metadata, {
    name: 'Éclair',
    symbol: 'ECL',
    description: 'lancement public',
    imageUrl: 'https://cdn.example/image.png',
    videoUrl: 'https://cdn.example/video.mp4',
    websiteUrl: 'https://example.org',
    twitterUrl: 'https://x.com/eclair',
    telegramUrl: 'https://t.me/eclair',
  });
  assert.ok(Object.isFrozen(metadata));
});

void test('rejette les champs de métadonnées publics de type incorrect', () => {
  assert.throws(
    () => normalizePublicTokenMetadata({ name: 1 }),
    /name/u,
  );
});

void test('convertit les champs absents ou vides en null', () => {
  assert.deepEqual(normalizePublicTokenMetadata({
    name: ' ', symbol: '', image: '  ',
  }), {
    name: null,
    symbol: null,
    description: null,
    imageUrl: null,
    videoUrl: null,
    websiteUrl: null,
    twitterUrl: null,
    telegramUrl: null,
  });
});

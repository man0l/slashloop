// Provider registry — the "add a platform" seam. A new provider = one file
// in providers/ + one entry here.

import { BadBodyError } from './errors.js';
import { InstagramProvider } from './providers/instagram.js';
import { ThreadsProvider } from './providers/threads.js';
import { TikTokProvider } from './providers/tiktok.js';
import { YouTubeProvider } from './providers/youtube.js';
import type { ProviderId, SocialConfig, SocialProvider } from './types.js';

export function createRegistry(cfg: SocialConfig): Map<ProviderId, SocialProvider> {
  const registry = new Map<ProviderId, SocialProvider>();
  const register = (provider: SocialProvider) => {
    provider.configure?.(cfg);
    registry.set(provider.identifier, provider);
  };

  register(new TikTokProvider());
  register(new YouTubeProvider());
  register(new InstagramProvider());
  register(new ThreadsProvider());

  return registry;
}

export function getProvider(registry: Map<ProviderId, SocialProvider>, id: string): SocialProvider {
  const provider = registry.get(id as ProviderId);
  if (!provider) throw new BadBodyError(`Unsupported platform: ${id}`);
  return provider;
}

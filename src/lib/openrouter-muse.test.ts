import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { generateOpenRouterImage, RECREATE_IMAGE_MODEL } from './openrouter.js';

const originalKey = process.env.OPENROUTER_API_KEY;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe('Muse image default', () => {
  test('sends meta/muse-image to the real image adapter and decodes a mocked result', async () => {
    process.env.OPENROUTER_API_KEY = 'local-test-only';
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: image.toString('base64'), media_type: 'image/jpeg' }],
      usage: { cost: 0.0123 },
    }), { status: 200 }));

    const result = await generateOpenRouterImage({ prompt: 'A blue ceramic bowl', referenceUrl: 'https://example.com/reference.jpg', quality: 'low', aspectRatio: '9:16' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toEndWith('/images');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ model: 'meta/muse-image', prompt: 'A blue ceramic bowl\nCompose the image in 9:16 aspect ratio.', input_references: [{type:'image_url',image_url:{url:'https://example.com/reference.jpg'}}] });
    expect(result.buffer).toEqual(image);
    expect(result.contentType).toBe('image/jpeg');
    expect(result.costUsd).toBe(0.0123);
    expect(RECREATE_IMAGE_MODEL).toBe('meta/muse-image');
  });
});

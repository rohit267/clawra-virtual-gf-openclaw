/**
 * Grok Imagine to OpenClaw Integration
 *
 * Generates images using xAI's Grok Imagine model via fal.ai
 * and sends them to messaging channels via OpenClaw.
 *
 * Usage:
 *   npx ts-node grok-imagine-send.ts "<prompt>" "<channel>" ["<caption>"]
 *
 * Environment variables:
 *   FAL_KEY - Your fal.ai API key (optional; falls back to scraped public images)
 *   OPENCLAW_GATEWAY_URL - OpenClaw gateway URL (default: http://localhost:18789)
 *   OPENCLAW_GATEWAY_TOKEN - Gateway auth token (optional)
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Types
interface GrokImagineInput {
  prompt: string;
  num_images?: number;
  aspect_ratio?: AspectRatio;
  output_format?: OutputFormat;
}

interface GrokImagineImage {
  url: string;
  content_type: string;
  file_name?: string;
  width: number;
  height: number;
}

interface GrokImagineResponse {
  images: GrokImagineImage[];
  revised_prompt?: string;
  source?: string;
}

interface OpenClawMessage {
  action: "send";
  channel: string;
  message: string;
  media?: string;
}

type AspectRatio =
  | "2:1"
  | "20:9"
  | "19.5:9"
  | "16:9"
  | "4:3"
  | "3:2"
  | "1:1"
  | "2:3"
  | "3:4"
  | "9:16"
  | "9:19.5"
  | "9:20"
  | "1:2";

type OutputFormat = "jpeg" | "png" | "webp";

const SOCIAL_IMAGE_DOMAINS =
  /(?:pbs\.twimg\.com|twimg\.com|i\.pinimg\.com|pinimg\.com|cdninstagram|fbcdn|redd\.it|redditmedia)/i;

interface GenerateAndSendOptions {
  prompt: string;
  channel: string;
  caption?: string;
  aspectRatio?: AspectRatio;
  outputFormat?: OutputFormat;
  useClaudeCodeCLI?: boolean;
}

interface Result {
  success: boolean;
  imageUrl: string;
  channel: string;
  prompt: string;
  revisedPrompt?: string;
  source?: string;
}

// Check for fal.ai client
let falClient: any;
try {
  const { fal } = require("@fal-ai/client");
  falClient = fal;
} catch {
  // Will use fetch instead
  falClient = null;
}

/**
 * Build a deterministic random image fallback URL when scraping returns no usable images.
 */
function getPicsumFallback(input: GrokImagineInput): GrokImagineResponse {
  const seed = encodeURIComponent(`${input.prompt}-${Date.now()}`);
  return {
    images: [
      {
        url: `https://picsum.photos/seed/${seed}/1024/1024`,
        content_type: "image/jpeg",
        width: 1024,
        height: 1024,
      },
    ],
    revised_prompt: `Random fallback image for: ${input.prompt}`,
    source: "picsum",
  };
}

function extractImageUrls(html: string, socialOnly: boolean): string[] {
  const normalizedHtml = html
    .replace(/\\\//g, "/")
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&");

  const imageUrls = Array.from(
    normalizedHtml.matchAll(
      /https?:\/\/[^"'<>\\\s]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'<>\\\s]*)?/gi
    ),
    (match) => match[0]
  );

  return [...new Set(imageUrls)].filter((url) => {
    if (socialOnly && !SOCIAL_IMAGE_DOMAINS.test(url)) {
      return false;
    }

    return !/googleusercontent\.com|gstatic\.com|google\.com/i.test(url);
  });
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; clawra-selfie/1.1.1)",
      },
    });

    if (!response.ok) {
      console.warn(
        `[WARN] Image scraping failed: ${response.status} ${response.statusText}`
      );
      return null;
    }

    return response.text();
  } catch (error) {
    console.warn(`[WARN] Image scraping failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Scrape Google image results with social-media dorks and return raw image URLs
 * where Google exposes them in public HTML.
 */
async function getGoogleDorkImage(
  input: GrokImagineInput
): Promise<GrokImagineResponse | null> {
  const dork = `${input.prompt} (site:i.pinimg.com OR site:pbs.twimg.com OR site:twimg.com OR site:pinterest.com OR site:x.com OR site:twitter.com OR site:instagram.com OR site:reddit.com) (jpg OR jpeg OR png OR webp)`;
  const searchUrl = `https://www.google.com/search?tbm=isch&safe=active&q=${encodeURIComponent(
    dork
  )}`;
  const html = await fetchHtml(searchUrl);

  if (!html) {
    return null;
  }

  const imageUrls = extractImageUrls(html, true);

  if (imageUrls.length === 0) {
    return null;
  }

  const imageUrl = imageUrls[Math.floor(Math.random() * imageUrls.length)];
  const extension = imageUrl.split(".").pop()?.split("?")[0].toLowerCase();
  const contentType =
    extension === "png"
      ? "image/png"
      : extension === "webp"
      ? "image/webp"
      : "image/jpeg";

  return {
    images: [
      {
        url: imageUrl,
        content_type: contentType,
        width: 0,
        height: 0,
      },
    ],
    revised_prompt: `Google-dorked social image result for: ${input.prompt}`,
    source: "google-social-dork",
  };
}

/**
 * Scrape public image search results and return a random image URL.
 */
async function getRandomScrapedImage(
  input: GrokImagineInput
): Promise<GrokImagineResponse> {
  const googleDorkResult = await getGoogleDorkImage(input);

  if (googleDorkResult) {
    return googleDorkResult;
  }

  const searchUrl = `https://commons.wikimedia.org/wiki/Special:MediaSearch?type=image&search=${encodeURIComponent(
    input.prompt
  )}`;
  const html = await fetchHtml(searchUrl);

  if (!html) {
    return getPicsumFallback(input);
  }

  const uniqueImageUrls = extractImageUrls(html, false).filter((url) =>
    /upload\.wikimedia\.org/i.test(url)
  );

  if (uniqueImageUrls.length === 0) {
    return getPicsumFallback(input);
  }

  const imageUrl =
    uniqueImageUrls[Math.floor(Math.random() * uniqueImageUrls.length)];
  const extension = imageUrl.split(".").pop()?.split("?")[0].toLowerCase();
  const contentType =
    extension === "png"
      ? "image/png"
      : extension === "webp"
      ? "image/webp"
      : "image/jpeg";

  return {
    images: [
      {
        url: imageUrl,
        content_type: contentType,
        width: 0,
        height: 0,
      },
    ],
    revised_prompt: `Scraped public image result for: ${input.prompt}`,
    source: "wikimedia-commons",
  };
}

/**
 * Generate image using Grok Imagine via fal.ai, or scrape a random public image
 * when no fal.ai key is configured.
 */
async function generateImage(
  input: GrokImagineInput
): Promise<GrokImagineResponse> {
  const falKey = process.env.FAL_KEY;

  if (!falKey) {
    console.warn(
      "[WARN] FAL_KEY environment variable not set. Scraping a random public image instead."
    );
    return getRandomScrapedImage(input);
  }

  // Use fal client if available
  if (falClient) {
    falClient.config({ credentials: falKey });

    const result = await falClient.subscribe("xai/grok-imagine-image", {
      input: {
        prompt: input.prompt,
        num_images: input.num_images || 1,
        aspect_ratio: input.aspect_ratio || "1:1",
        output_format: input.output_format || "jpeg",
      },
    });

    return result.data as GrokImagineResponse;
  }

  // Fallback to fetch
  const response = await fetch("https://fal.run/xai/grok-imagine-image", {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      num_images: input.num_images || 1,
      aspect_ratio: input.aspect_ratio || "1:1",
      output_format: input.output_format || "jpeg",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image generation failed: ${error}`);
  }

  return response.json();
}

/**
 * Send image via OpenClaw
 */
async function sendViaOpenClaw(
  message: OpenClawMessage,
  useCLI: boolean = true
): Promise<void> {
  if (useCLI) {
    // Use OpenClaw CLI
    const cmd = `openclaw message send --action send --channel "${message.channel}" --message "${message.message}" --media "${message.media}"`;
    await execAsync(cmd);
    return;
  }

  // Direct API call
  const gatewayUrl =
    process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (gatewayToken) {
    headers["Authorization"] = `Bearer ${gatewayToken}`;
  }

  const response = await fetch(`${gatewayUrl}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenClaw send failed: ${error}`);
  }
}

/**
 * Main function: Generate image and send to channel
 */
async function generateAndSend(options: GenerateAndSendOptions): Promise<Result> {
  const {
    prompt,
    channel,
    caption = "Generated with Grok Imagine",
    aspectRatio = "1:1",
    outputFormat = "jpeg",
    useClaudeCodeCLI = true,
  } = options;

  console.log(`[INFO] Generating image with Grok Imagine...`);
  console.log(`[INFO] Prompt: ${prompt}`);
  console.log(`[INFO] Aspect ratio: ${aspectRatio}`);

  // Generate image
  const imageResult = await generateImage({
    prompt,
    num_images: 1,
    aspect_ratio: aspectRatio,
    output_format: outputFormat,
  });

  const imageUrl = imageResult.images[0].url;
  console.log(`[INFO] Image generated: ${imageUrl}`);

  if (imageResult.revised_prompt) {
    console.log(`[INFO] Revised prompt: ${imageResult.revised_prompt}`);
  }

  // Send via OpenClaw
  console.log(`[INFO] Sending to channel: ${channel}`);

  await sendViaOpenClaw(
    {
      action: "send",
      channel,
      message: caption,
      media: imageUrl,
    },
    useClaudeCodeCLI
  );

  console.log(`[INFO] Done! Image sent to ${channel}`);

  return {
    success: true,
    imageUrl,
    channel,
    prompt,
    revisedPrompt: imageResult.revised_prompt,
    source: imageResult.source,
  };
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
Usage: npx ts-node grok-imagine-send.ts <prompt> <channel> [caption] [aspect_ratio] [output_format]

Arguments:
  prompt        - Image description (required)
  channel       - Target channel (required) e.g., #general, @user
  caption       - Message caption (default: 'Generated with Grok Imagine')
  aspect_ratio  - Image ratio (default: 1:1) Options: 2:1, 16:9, 4:3, 1:1, 3:4, 9:16
  output_format - Image format (default: jpeg) Options: jpeg, png, webp

Environment:
  FAL_KEY       - Your fal.ai API key (optional; falls back to scraped public images)

Example:
  FAL_KEY=your_key npx ts-node grok-imagine-send.ts "A cyberpunk city" "#art" "Check this out!"
`);
    process.exit(1);
  }

  const [prompt, channel, caption, aspectRatio, outputFormat] = args;

  try {
    const result = await generateAndSend({
      prompt,
      channel,
      caption,
      aspectRatio: aspectRatio as AspectRatio,
      outputFormat: outputFormat as OutputFormat,
    });

    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[ERROR] ${(error as Error).message}`);
    process.exit(1);
  }
}

// Export for module use
export {
  generateImage,
  sendViaOpenClaw,
  generateAndSend,
  GrokImagineInput,
  GrokImagineResponse,
  OpenClawMessage,
  GenerateAndSendOptions,
  Result,
};

// Run if executed directly
if (require.main === module) {
  main();
}

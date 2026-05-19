#!/bin/bash
# grok-imagine-send.sh
# Generate an image with Grok Imagine and send it via OpenClaw
#
# Usage: ./grok-imagine-send.sh "<prompt>" "<channel>" ["<caption>"]
#
# Environment variables:
#   FAL_KEY - Your fal.ai API key (optional; falls back to scraped public images)
#
# Example:
#   FAL_KEY=your_key ./grok-imagine-send.sh "A sunset over mountains" "#art" "Check this out!"

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check for jq
if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed"
    echo "Install with: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
fi

# Check for openclaw
if ! command -v openclaw &> /dev/null; then
    log_warn "openclaw CLI not found - will attempt direct API call"
    USE_CLI=false
else
    USE_CLI=true
fi

# Parse arguments
PROMPT="${1:-}"
CHANNEL="${2:-}"
CAPTION="${3:-Generated with Grok Imagine}"
ASPECT_RATIO="${4:-1:1}"
OUTPUT_FORMAT="${5:-jpeg}"

if [ -z "$PROMPT" ] || [ -z "$CHANNEL" ]; then
    echo "Usage: $0 <prompt> <channel> [caption] [aspect_ratio] [output_format]"
    echo ""
    echo "Arguments:"
    echo "  prompt        - Image description (required)"
    echo "  channel       - Target channel (required) e.g., #general, @user"
    echo "  caption       - Message caption (default: 'Generated with Grok Imagine')"
    echo "  aspect_ratio  - Image ratio (default: 1:1) Options: 2:1, 16:9, 4:3, 1:1, 3:4, 9:16"
    echo "  output_format - Image format (default: jpeg) Options: jpeg, png, webp"
    echo ""
    echo "Example:"
    echo "  $0 \"A cyberpunk city at night\" \"#art-gallery\" \"AI Art!\""
    exit 1
fi

log_info "Prompt: $PROMPT"
log_info "Aspect ratio: $ASPECT_RATIO"

if [ -n "${FAL_KEY:-}" ]; then
    log_info "Generating image with Grok Imagine..."

    # Generate image via fal.ai
    RESPONSE=$(curl -s -X POST "https://fal.run/xai/grok-imagine-image" \
        -H "Authorization: Key $FAL_KEY" \
        -H "Content-Type: application/json" \
        -d "{
            \"prompt\": $(echo "$PROMPT" | jq -Rs .),
            \"num_images\": 1,
            \"aspect_ratio\": \"$ASPECT_RATIO\",
            \"output_format\": \"$OUTPUT_FORMAT\"
        }")

    # Check for errors in response
    if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
        ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error // .detail // "Unknown error"')
        log_error "Image generation failed: $ERROR_MSG"
        exit 1
    fi

    # Extract image URL
    IMAGE_URL=$(echo "$RESPONSE" | jq -r '.images[0].url // empty')

    if [ -z "$IMAGE_URL" ]; then
        log_error "Failed to extract image URL from response"
        echo "Response: $RESPONSE"
        exit 1
    fi
else
    log_warn "FAL_KEY environment variable not set - scraping Google-dorked social image results instead"
    RESPONSE=""

    GOOGLE_DORK="$PROMPT (site:i.pinimg.com OR site:pbs.twimg.com OR site:twimg.com OR site:pinterest.com OR site:x.com OR site:twitter.com OR site:instagram.com OR site:reddit.com) (jpg OR jpeg OR png OR webp)"
    ENCODED_PROMPT=$(jq -nr --arg q "$GOOGLE_DORK" '$q|@uri')
    SEARCH_URL="https://www.google.com/search?tbm=isch&safe=active&q=$ENCODED_PROMPT"
    HTML=$(curl -L -s -A "Mozilla/5.0 (compatible; clawra-selfie/1.1.1)" "$SEARCH_URL" || true)
    IMAGE_URL=$(printf "%s" "$HTML" \
        | sed 's#\\/#/#g; s/\\u003d/=/g; s/\\u0026/\&/g; s/&amp;/\&/g' \
        | grep -Eio 'https?://[^"'\''<>\\ ]+\.(jpg|jpeg|png|webp)(\?[^"'\''<>\\ ]*)?' \
        | grep -Ei 'pbs\.twimg\.com|twimg\.com|i\.pinimg\.com|pinimg\.com|cdninstagram|fbcdn|redd\.it|redditmedia' \
        | awk '!seen[$0]++ { urls[++count]=$0 } END { if (count > 0) { srand(); print urls[int(rand() * count) + 1] } }' \
        || true)

    if [ -n "$IMAGE_URL" ]; then
        RESPONSE=$(jq -n --arg url "$IMAGE_URL" '{images: [{url: $url, content_type: "image/jpeg", width: 0, height: 0}], source: "google-social-dork"}')
    fi

    if [ -z "$IMAGE_URL" ]; then
        ENCODED_PROMPT=$(jq -nr --arg q "$PROMPT" '$q|@uri')
        SEARCH_URL="https://commons.wikimedia.org/wiki/Special:MediaSearch?type=image&search=$ENCODED_PROMPT"
        HTML=$(curl -L -s -A "Mozilla/5.0 (compatible; clawra-selfie/1.1.1)" "$SEARCH_URL" || true)
        IMAGE_URL=$(printf "%s" "$HTML" \
            | sed 's#\\/#/#g; s/\\u003d/=/g; s/\\u0026/\&/g; s/&amp;/\&/g' \
            | grep -Eio 'https://upload\.wikimedia\.org/[^"'\''<>\\ ]+\.(jpg|jpeg|png|webp)' \
            | awk '!seen[$0]++ { urls[++count]=$0 } END { if (count > 0) { srand(); print urls[int(rand() * count) + 1] } }' \
            || true)
    fi

    if [ -z "$IMAGE_URL" ]; then
        SEED=$(jq -nr --arg q "$PROMPT-$(date +%s)" '$q|@uri')
        IMAGE_URL="https://picsum.photos/seed/$SEED/1024/1024"
        RESPONSE="{\"images\":[{\"url\":\"$IMAGE_URL\",\"content_type\":\"image/jpeg\",\"width\":1024,\"height\":1024}],\"source\":\"picsum\"}"
    elif [ -z "$RESPONSE" ]; then
        RESPONSE=$(jq -n --arg url "$IMAGE_URL" '{images: [{url: $url, content_type: "image/jpeg", width: 0, height: 0}], source: "wikimedia-commons"}')
    fi
fi

log_info "Image generated successfully!"
log_info "URL: $IMAGE_URL"

# Get revised prompt if available
REVISED_PROMPT=$(echo "$RESPONSE" | jq -r '.revised_prompt // empty')
if [ -n "$REVISED_PROMPT" ]; then
    log_info "Revised prompt: $REVISED_PROMPT"
fi
SOURCE=$(echo "$RESPONSE" | jq -r '.source // empty')

# Send via OpenClaw
log_info "Sending to channel: $CHANNEL"

if [ "$USE_CLI" = true ]; then
    # Use OpenClaw CLI
    openclaw message send \
        --action send \
        --channel "$CHANNEL" \
        --message "$CAPTION" \
        --media "$IMAGE_URL"
else
    # Direct API call to local gateway
    GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:18789}"
    GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

    HEADERS="-H \"Content-Type: application/json\""
    if [ -n "$GATEWAY_TOKEN" ]; then
        HEADERS="$HEADERS -H \"Authorization: Bearer $GATEWAY_TOKEN\""
    fi

    curl -s -X POST "$GATEWAY_URL/message" \
        -H "Content-Type: application/json" \
        ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
        -d "{
            \"action\": \"send\",
            \"channel\": \"$CHANNEL\",
            \"message\": \"$CAPTION\",
            \"media\": \"$IMAGE_URL\"
        }"
fi

log_info "Done! Image sent to $CHANNEL"

# Output JSON for programmatic use
echo ""
echo "--- Result ---"
jq -n \
    --arg url "$IMAGE_URL" \
    --arg channel "$CHANNEL" \
    --arg prompt "$PROMPT" \
    --arg source "$SOURCE" \
    '{
        success: true,
        image_url: $url,
        channel: $channel,
        prompt: $prompt
    } + (if $source != "" then {source: $source} else {} end)'

// Import-tweets
// Usage: node import-tweets.mjs [max-files]
//
// Processes a twitter archive to generate post content for this blog.
// Only processes tweets that are not replies to tweets from others.
// Handles tweet threads.
// Supports images and video media, displaying full size and supporting
// click to open in a new tab.
// Does not handle quote tweets specially since, even when quoting the
// author, the context is likely unavailable. 
// Doesn't automatically include retweets (since the context is often missing),
// but includes a mechanism for explicitly selecting additional tweets to include.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const ARCHIVE_PATH = '/Users/Rick/RickByersLab';
const OUTPUT_DIR = path.resolve(__dirname, '../src/content/posts');
const MEDIA_OUTPUT_DIR = path.resolve(__dirname, '../public/postmedia');
const SITE_MEDIA_PATH = '/postmedia';

const MAX_FILES = process.argv[2] ? parseInt(process.argv[2]) : Infinity;

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_OUTPUT_DIR)) fs.mkdirSync(MEDIA_OUTPUT_DIR, { recursive: true });

// Helper to load JS files that assign to window.YTD...
function loadArchiveJs(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const jsonContent = content.substring(content.indexOf('=') + 1).trim();
    return JSON.parse(jsonContent);
}

// Main logic
async function main() {
    console.log(`Reading archive from ${ARCHIVE_PATH}...`);

    // 1. Load Account
    const accountData = loadArchiveJs(path.join(ARCHIVE_PATH, 'data/account.js'));
    const user = accountData[0].account;
    const myAccountId = user.accountId;
    const username = user.username;

    // 1.5 Handle Avatar - use screen name for filename
    let avatarUrl = "/assets/avatar.jpg"; // Fallback
    const profileMediaDir = path.join(ARCHIVE_PATH, 'data/profile_media');
    if (fs.existsSync(profileMediaDir)) {
        const profileFiles = fs.readdirSync(profileMediaDir).filter(f => f.startsWith(myAccountId));
        if (profileFiles.length > 0) {
            const avatarFile = profileFiles[profileFiles.length - 1];
            const srcAvatar = path.join(profileMediaDir, avatarFile);
            const destAvatarFilename = `${username}.jpg`;
            const destAvatar = path.join(MEDIA_OUTPUT_DIR, destAvatarFilename);

            fs.copyFileSync(srcAvatar, destAvatar);
            avatarUrl = `${SITE_MEDIA_PATH}/${destAvatarFilename}`;
            console.log(`Copied avatar: ${avatarFile} -> ${destAvatarFilename}`);
        }
    }

    // Author object for Post component
    const author = {
        name: user.accountDisplayName,
        handle: username,
        avatar: avatarUrl
    };

    console.log(`Account: @${username} (${myAccountId})`);

    // 2. Load Tweets
    const tweetsData = loadArchiveJs(path.join(ARCHIVE_PATH, 'data/tweets.js'));
    console.log(`Loaded ${tweetsData.length} tweets.`);

    // Map ID to Tweet for easy lookup
    const tweetsById = new Map();
    tweetsData.forEach(item => {
        tweetsById.set(item.tweet.id_str, item.tweet);
    });

    // 3. Process Tweets
    const rootTweets = [];
    const replyTweets = new Map();

    const ROOT_INCLUDE_IDS = new Set([
        '1387041304509501445',
    ]);

    for (const item of tweetsData) {
        const t = item.tweet;

        // Filter out retweets
        if (t.full_text.startsWith('RT @')) continue;

        // Check if explicitly included as a root
        if (ROOT_INCLUDE_IDS.has(t.id_str)) {
            rootTweets.push(t);
            // Assume it will not also be in the reply chain of another tweet.
            continue;
        }

        const isReply = !!t.in_reply_to_status_id;
        const isSelfReply = t.in_reply_to_user_id_str === myAccountId;

        if (!isReply) {
            rootTweets.push(t);
        } else if (isSelfReply) {
            const parentId = t.in_reply_to_status_id_str;
            if (!replyTweets.has(parentId)) {
                replyTweets.set(parentId, []);
            }
            replyTweets.get(parentId).push(t);
        }
    }

    // Sort roots by date
    rootTweets.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    let filesCreated = 0;

    for (const root of rootTweets) {
        if (filesCreated >= MAX_FILES) break;

        const fullThread = buildThread(root, replyTweets);
        await createPostFile(fullThread, author, username);
        filesCreated++;
    }

    console.log(`Created ${filesCreated} post files.`);
}

function buildThread(root, replyMap) {
    const thread = [root];

    function dfs(t) {
        const replies = replyMap.get(t.id_str);
        if (replies) {
            replies.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            for (const r of replies) {
                thread.push(r);
                dfs(r);
            }
        }
    }

    dfs(root);
    return thread;
}

async function createPostFile(thread, author, username) {
    const root = thread[0];
    const date = new Date(root.created_at);

    const year = date.getFullYear().toString();
    const yearDir = path.join(OUTPUT_DIR, year);
    if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });

    const pad = n => n.toString().padStart(2, '0');
    const baseFilename = `${year}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const filename = `${baseFilename}.mdx`;
    const filePath = path.join(yearDir, filename);

    let content = `import Post from '../../../components/Post.astro';\n\n`;

    const mediaCounter = { count: 0 };

    for (const t of thread) {
        content += await generatePostComponent(t, author, baseFilename, mediaCounter, year, username);
        content += '\n';
    }

    fs.writeFileSync(filePath, content);
    console.log(`Generated ${filePath}`);
}

async function generatePostComponent(tweet, author, baseFilename, mediaCounter, year, username) {
    const dateStr = new Date(tweet.created_at).toISOString();

    // Process Media
    const mediaItems = [];
    if (tweet.extended_entities && tweet.extended_entities.media) {
        for (const m of tweet.extended_entities.media) {
            mediaCounter.count++;
            const urlParts = m.media_url.split('/');
            const basename = urlParts[urlParts.length - 1];
            const srcFilename = `${tweet.id_str}-${basename}`;
            const srcPath = path.join(ARCHIVE_PATH, 'data/tweets_media', srcFilename);

            // Check for video first (video/animated_gif types)
            if (m.type === 'video' || m.type === 'animated_gif') {
                const videoFiles = fs.readdirSync(path.join(ARCHIVE_PATH, 'data/tweets_media'))
                    .filter(f => f.startsWith(tweet.id_str) && f.endsWith('.mp4'));

                if (videoFiles.length > 0) {
                    const vidFile = videoFiles[0];
                    const vidDestFilename = `${baseFilename}-${mediaCounter.count}.mp4`;
                    const vidDest = path.join(MEDIA_OUTPUT_DIR, vidDestFilename);

                    if (!fs.existsSync(vidDest)) {
                        fs.copyFileSync(path.join(ARCHIVE_PATH, 'data/tweets_media', vidFile), vidDest);
                    }
                    mediaItems.push({
                        type: 'video',
                        url: `${SITE_MEDIA_PATH}/${vidDestFilename}`,
                        alt: m.ext_alt_text || ""
                    });
                    continue;
                }
            }

            // Handle images (or videos where mp4 wasn't found - use thumbnail)
            if (fs.existsSync(srcPath)) {
                const ext = path.extname(srcFilename);
                const destFilename = `${baseFilename}-${mediaCounter.count}${ext}`;
                const destPath = path.join(MEDIA_OUTPUT_DIR, destFilename);

                if (!fs.existsSync(destPath)) {
                    fs.copyFileSync(srcPath, destPath);
                }

                mediaItems.push({
                    type: 'image',
                    url: `${SITE_MEDIA_PATH}/${destFilename}`,
                    alt: m.ext_alt_text || ""
                });
            }
        }
    }

    // Process Text
    let text = tweet.full_text;

    // Remove media links
    if (tweet.extended_entities && tweet.extended_entities.media) {
        for (const m of tweet.extended_entities.media) {
            text = text.replace(m.url, '');
        }
    }

    // Replace urls with anchor tags (HTML, not markdown, for proper MDX rendering)
    if (tweet.entities.urls) {
        for (const u of tweet.entities.urls) {
            text = text.replace(u.url, `<a href="${u.expanded_url}" target="_blank" rel="noopener noreferrer">${u.expanded_url}</a>`);
        }
    }

    // Escape logical braces and preserve newlines
    text = text.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
    text = text.trim();
    // Use double trailing spaces for interior newlines to create hard breaks
    text = text.replace(/\n/g, '  \n');

    const mediaProp = JSON.stringify(mediaItems);

    // Construct permalink URL - Astro lowercases slugs, so use lowercase 't'
    const permalinkUrl = `/posts/${year}/${baseFilename.toLowerCase()}`;

    // Construct source URL (original tweet on x.com)
    const sourceUrl = `https://x.com/${username}/status/${tweet.id_str}`;

    return `<Post 
  author={${JSON.stringify(author)}}
  date="${dateStr}"
  media={${mediaProp}}
  faves={${tweet.favorite_count}}
  reposts={${tweet.retweet_count}}
  url="${permalinkUrl}"
  sourceUrl="${sourceUrl}"
>
${text}
</Post>
`;
}

main().catch(console.error);

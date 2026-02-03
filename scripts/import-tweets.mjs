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
const ARCHIVE_PATH = '/Users/Rick/twitter/RickByersLab';
const SECONDARY_ARCHIVE_PATH = '/Users/Rick/twitter/RickByers';
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

    // 1.8 Load Secondary Account (if available)
    let secondaryUser, secondaryAuthor, secondaryTweetsData, secondaryReplyTweets;
    let secondaryTweetsById = new Map();

    if (fs.existsSync(SECONDARY_ARCHIVE_PATH)) {
        console.log(`Loading secondary archive from ${SECONDARY_ARCHIVE_PATH}...`);
        const secAccountData = loadArchiveJs(path.join(SECONDARY_ARCHIVE_PATH, 'data/account.js'));
        secondaryUser = secAccountData[0].account;
        const secUsername = secondaryUser.username;
        const secAccountId = secondaryUser.accountId;

        // Secondary Avatar
        let secAvatarUrl = "/assets/avatar.jpg";
        const secProfileMediaDir = path.join(SECONDARY_ARCHIVE_PATH, 'data/profile_media');
        if (fs.existsSync(secProfileMediaDir)) {
            const profileFiles = fs.readdirSync(secProfileMediaDir).filter(f => f.startsWith(secAccountId));
            if (profileFiles.length > 0) {
                const avatarFile = profileFiles[profileFiles.length - 1];
                const srcAvatar = path.join(secProfileMediaDir, avatarFile);
                const destAvatarFilename = `${secUsername}.jpg`;
                const destAvatar = path.join(MEDIA_OUTPUT_DIR, destAvatarFilename);

                // Only copy if it doesn't exist to save IO? Or just overwrite.
                fs.copyFileSync(srcAvatar, destAvatar);
                secAvatarUrl = `${SITE_MEDIA_PATH}/${destAvatarFilename}`;
                console.log(`Copied secondary avatar: ${avatarFile} -> ${destAvatarFilename}`);
            }
        }

        secondaryAuthor = {
            name: secondaryUser.accountDisplayName,
            handle: secUsername,
            avatar: secAvatarUrl
        };

        // Load Secondary Tweets
        secondaryTweetsData = loadArchiveJs(path.join(SECONDARY_ARCHIVE_PATH, 'data/tweets.js'));
        console.log(`Loaded ${secondaryTweetsData.length} secondary tweets.`);

        // Map Secondary ID to Tweet
        secondaryTweetsData.forEach(item => {
            secondaryTweetsById.set(item.tweet.id_str, item.tweet);
        });

        // Build Secondary Reply Map
        secondaryReplyTweets = new Map();
        secondaryTweetsData.forEach(item => {
            const t = item.tweet;
            const isReply = !!t.in_reply_to_status_id;
            const isSelfReply = t.in_reply_to_user_id_str === secAccountId;

            if (isReply && isSelfReply) {
                const parentId = t.in_reply_to_status_id_str;
                if (!secondaryReplyTweets.has(parentId)) {
                    secondaryReplyTweets.set(parentId, []);
                }
                secondaryReplyTweets.get(parentId).push(t);
            }
        });
    }
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

    const processedSecondaryThreadIds = new Set();
    let filesCreated = 0;

    for (const item of tweetsData) {
        const t = item.tweet;

        // Check for Retweet from Secondary Account
        if (secondaryUser && t.full_text.startsWith(`RT @${secondaryUser.username}:`)) {
            // "RT @Username: Actual text..."
            // Remove prefix "RT @Username: "
            const prefix = `RT @${secondaryUser.username}: `;
            let cleanText = t.full_text.substring(prefix.length);
            // Remove trailing ellipsis if present (Twitter truncates retweets sometimes?)
            // Usually local archive full_text is complete, but let's handle standard RT truncation just in case,
            // or if the user instruction implies checking for truncated matches.
            // The instructions said "remove any trailing elipsis".
            if (cleanText.endsWith('…')) {
                cleanText = cleanText.substring(0, cleanText.length - 1).trim();
            } else if (cleanText.endsWith('...')) { // just in case
                cleanText = cleanText.substring(0, cleanText.length - 3).trim();
            }

            // Find match in secondary archive
            // This is O(N*M) worst case, but N and M are small enough for a script.
            // optimization: Pre-index secondary tweets by first few chars? 
            // For now simple search.
            const matchItem = secondaryTweetsData.find(st => {
                return st.tweet.full_text.startsWith(cleanText);
            });

            if (matchItem) {
                const originalRoot = matchItem.tweet;

                // If this is a reply (part of a thread), we should find the true root of that thread?
                // The instructions say: "Tweet threads for the seondary account should be processed in the same way as we already do for the primary account"
                // "If the primary account retweets multiple posts in the same thread from the secondary account, we should emit only the single thread."

                // So if the matching tweet is NOT a root (i.e. it is a reply), we should probably walk up to the root?
                // OR, assume the retweet found a root.
                // If I retweet a reply, usually valid thread handling would mean I want the whole context.
                // But for now let's assume `matchItem.tweet` is the one we want to start from, OR checks if it is a reply.
                // Our current logic `isReply = !!t.in_reply_to_status_id`.

                // Find true root of the thread
                let threadRoot = originalRoot;
                while (threadRoot.in_reply_to_status_id_str && secondaryTweetsById.has(threadRoot.in_reply_to_status_id_str)) {
                    threadRoot = secondaryTweetsById.get(threadRoot.in_reply_to_status_id_str);
                }

                // IMPORTANT: Logic 'Deduplication'
                // If we have already processed this secondary thread, skip.
                if (processedSecondaryThreadIds.has(threadRoot.id_str)) {
                    continue;
                }

                // Build thread from secondary
                const fullThread = buildThread(threadRoot, secondaryReplyTweets);
                await createPostFile(fullThread, secondaryAuthor, secondaryUser.username, SECONDARY_ARCHIVE_PATH);
                processedSecondaryThreadIds.add(threadRoot.id_str);
                filesCreated++;
                continue;
            } else {
                console.warn(`Could not find original tweet for RT: "${cleanText.substring(0, 20)}..."`);
            }
        }

        // Filter out retweets (general)
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

    for (const root of rootTweets) {
        if (filesCreated >= MAX_FILES) break;

        const fullThread = buildThread(root, replyTweets);
        await createPostFile(fullThread, author, username, ARCHIVE_PATH);
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

async function createPostFile(thread, author, username, archivePath) {
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
        content += await generatePostComponent(t, author, baseFilename, mediaCounter, year, username, archivePath);
        content += '\n';
    }

    fs.writeFileSync(filePath, content);
    console.log(`Generated ${filePath}`);
}

async function generatePostComponent(tweet, author, baseFilename, mediaCounter, year, username, archivePath) {
    const dateStr = new Date(tweet.created_at).toISOString();

    // Process Media
    const mediaItems = [];
    if (tweet.extended_entities && tweet.extended_entities.media) {
        for (const m of tweet.extended_entities.media) {
            mediaCounter.count++;
            const urlParts = m.media_url.split('/');
            const basename = urlParts[urlParts.length - 1];
            const srcFilename = `${tweet.id_str}-${basename}`;
            const srcPath = path.join(archivePath, 'data/tweets_media', srcFilename);

            // Check for video first (video/animated_gif types)
            if (m.type === 'video' || m.type === 'animated_gif') {
                const videoFiles = fs.readdirSync(path.join(archivePath, 'data/tweets_media'))
                    .filter(f => f.startsWith(tweet.id_str) && f.endsWith('.mp4'));

                if (videoFiles.length > 0) {
                    const vidFile = videoFiles[0];
                    const vidDestFilename = `${baseFilename}-${mediaCounter.count}.mp4`;
                    const vidDest = path.join(MEDIA_OUTPUT_DIR, vidDestFilename);

                    if (!fs.existsSync(vidDest)) {
                        fs.copyFileSync(path.join(archivePath, 'data/tweets_media', vidFile), vidDest);
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

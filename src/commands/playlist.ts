import axios from 'axios';
import * as fs from 'fs';
import { createMultiBar } from '../utils/progress';
import {
  getPlaylistInfo,
  checkSongAvailabilityWithRetry,
  getLyrics,
  proxyConfig,
  formatUnavailableHelp
} from '../services/netease';
import { sanitizeFileName, getDownloadPath } from '../utils/file';
import { tagFile } from '../services/tagger';

function extractPlaylistId(input: string): string {
  if (input.includes('music.163.com')) {
    const match = input.match(/[?&]id=(\d+)/);
    if (!match) {
      console.error('无效的歌单URL Invalid playlist URL');
      process.exit(1);
    }
    return match[1];
  }
  return input;
}

async function loadPlaylist(playlistInput: string) {
  const playlistId = extractPlaylistId(playlistInput);
  try {
    return await getPlaylistInfo(playlistId);
  } catch (error) {
    console.error('\n获取歌单信息失败 Failed to get playlist info');
    process.exit(1);
  }
}

export async function downloadPlaylist(playlistInput: string, options?: { autoProxy?: boolean }): Promise<void> {
  const { songs, playlistName, creatorName } = await loadPlaylist(playlistInput);

  console.log(`\n歌单信息 Playlist info: ${playlistName} - ${creatorName}`);
  console.log(`共 Total: ${songs.length} 首歌曲 songs\n`);

  const dirName = `${sanitizeFileName(playlistName)}`;
  const multibar = createMultiBar();
  const results = { success: 0, skipped: 0, failed: 0 };
  const failures: Array<{ index: number; name: string; id: string; reason: string }> = [];
  const recordFailure = (index: number, name: string, id: string, reason: string) => {
    results.failed++;
    failures.push({ index, name, id, reason: reason.replace(/\s*\n\s*/g, ' ') });
  };
  const MAX_RETRIES = 3;
  const pad = String(songs.length).length < 2 ? 2 : String(songs.length).length;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const artistName = song.artists?.[0]?.name || '未知歌手 Unknown Artist';
    const displayName = `${artistName}-${song.name}`;
    const prefix = `[${i + 1}/${songs.length}]`;
    let attempt = 0;

    while (true) {
      try {
        const availability = await checkSongAvailabilityWithRetry(song.id, options?.autoProxy);
        if (!availability.available || !availability.url) {
          console.log(`\n${prefix} ${displayName} 无法获取下载链接，跳过下载 Cannot get download URL, skipping download\n${formatUnavailableHelp(availability.reason, options?.autoProxy)}`);
          recordFailure(i + 1, displayName, song.id, availability.reason || '无法获取下载链接 Cannot get download URL');
          break;
        }

        const ext = availability.type || availability.url.split('.').pop()?.split('?')[0] || 'mp3';
        const base = `${String(i + 1).padStart(pad, '0')}.${sanitizeFileName(artistName)}-${sanitizeFileName(song.name)}`;
        const filePath = getDownloadPath('album', `${base}.${ext}`, dirName);
        const lrcPath = getDownloadPath('album', `${base}.lrc`, dirName);

        const lyrics = await getLyrics(song.id);
        if (lyrics) {
          fs.writeFileSync(lrcPath, lyrics, 'utf8');
          console.log(`${prefix} 歌词下载完成 Lyrics downloaded`);
        }

        if (fs.existsSync(filePath)) {
          console.log(`\n${prefix} ${base}.${ext} (文件已存在，跳过下载 File exists, skipping download)`);
          results.skipped++;
          break;
        }

        console.log(`\n${prefix} 开始下载 Start downloading: ${displayName}`);
        const response = await axios({
          method: 'get',
          url: availability.url,
          responseType: 'stream',
          ...(availability.needProxy ? proxyConfig : {})
        });

        const totalLength = parseInt(response.headers['content-length'], 10);
        const bar = multibar.create(Math.round(totalLength / 1024), 0, {
          name: `${prefix} ${song.name.slice(0, 30)}${song.name.length > 30 ? '...' : ''}`
        });
        const writer = fs.createWriteStream(filePath);
        let downloaded = 0;
        response.data.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          bar.update(Math.round(downloaded / 1024));
        });
        response.data.pipe(writer);

        try {
          await new Promise<void>((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', reject);
            response.data.on('error', reject);
          });
        } catch (err) {
          writer.destroy();
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          throw err;
        }

        if (downloaded < totalLength * 0.99) {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          throw new Error('下载不完整 Incomplete download');
        }
        bar.update(Math.round(totalLength / 1024));
        await tagFile(filePath, { song, lyrics });
        results.success++;
        break;
      } catch (error) {
        attempt++;
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (attempt < MAX_RETRIES) {
          console.error(`\n${prefix} ${song.name} - 下载出错，3 秒后重试 Download error, retrying in 3s (${attempt}/${MAX_RETRIES}): ${message}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        console.error(`\n${prefix} ${song.name} - 下载失败 Download failed: ${message}`);
        recordFailure(i + 1, displayName, song.id, message);
        break;
      }
    }
  }

  multibar.stop();
  console.log('\n歌单下载完成！Playlist download completed!');
  console.log(`${results.success} 首下载成功 songs downloaded, ${results.failed} 首失败 songs failed` + (results.skipped ? ` (${results.skipped} 首已存在已跳过 already existed, skipped)` : ''));

  if (failures.length > 0) {
    const lines = [
      `歌单 Playlist: ${playlistName} (${creatorName})`,
      `总计 Total: ${songs.length}, 成功 Downloaded: ${results.success}, 失败 Failed: ${results.failed}, 已存在跳过 Skipped: ${results.skipped}`,
      '',
      '失败歌曲 Failed songs (序号 # | 名称 name | ID | 原因 reason):',
      ...failures.map(f => `${f.index}. ${f.name} | ID ${f.id} | ${f.reason}`)
    ];
    const logPath = getDownloadPath('album', 'failed-songs.txt', dirName);
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    console.log(`失败列表已保存 Failed songs log saved: ${logPath}`);
  }
}

export async function downloadPlaylistLyrics(playlistInput: string): Promise<void> {
  const { songs, playlistName, creatorName } = await loadPlaylist(playlistInput);

  console.log(`\n歌单信息 Playlist info: ${playlistName} - ${creatorName}`);
  console.log(`共 Total: ${songs.length} 首歌曲 songs\n`);

  const dirName = sanitizeFileName(playlistName);
  const pad = String(songs.length).length < 2 ? 2 : String(songs.length).length;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const artistName = song.artists?.[0]?.name || '未知歌手 Unknown Artist';
    const prefix = `[${i + 1}/${songs.length}]`;
    console.log(`\n${prefix} 正在获取歌词 Getting lyrics: ${artistName}-${song.name}`);

    const lyrics = await getLyrics(song.id);
    if (!lyrics) {
      console.log(`${prefix} 该歌曲无歌词 No lyrics available for this song`);
      continue;
    }
    const fileName = `${String(i + 1).padStart(pad, '0')}.${sanitizeFileName(artistName)}-${sanitizeFileName(song.name)}.lrc`;
    fs.writeFileSync(getDownloadPath('album', fileName, dirName), lyrics, 'utf8');
    console.log(`${prefix} 歌词下载完成 Lyrics downloaded`);
  }

  console.log('\n歌单歌词下载完成！Playlist lyrics download completed!');
}

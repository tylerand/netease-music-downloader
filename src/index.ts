#!/usr/bin/env node

import { program } from 'commander';
import { downloadSong } from './commands/download';
import { downloadAlbum } from './commands/album';
import { downloadSongLyrics, downloadAlbumLyrics } from './commands/lyrics';
import { setProxy, initCookie } from './services/netease';
import { getAutoProxy } from './services/proxy';
import * as fs from 'fs';

program
  .name('netease-downloader')
  .description('网易云音乐下载工具 NetEase Cloud Music Downloader')
  .version('1.0.0')
  .option('-p, --proxy <url>', '设置代理服务器 Set proxy server (e.g. http://127.0.0.1:7890)')
  .option('-a, --auto-proxy', '当直连失败时自动寻找可用的中国代理服务器 Auto find available Chinese proxy server when direct connection fails')
  .option('-c, --cookie <value>', '登录 Cookie（MUSIC_U 值或完整 Cookie 字符串），也可用环境变量 NETEASE_MUSIC_U / NETEASE_COOKIE Login cookie (MUSIC_U value or full cookie string); env NETEASE_MUSIC_U / NETEASE_COOKIE also supported')
  .hook('preAction', async (thisCommand) => {
    const options = thisCommand.opts();
    initCookie(options.cookie);
    if (options.proxy) {
      setProxy(options.proxy);
    }
  });

program
  .command('download')
  .description('下载单个或多个音乐 Download single or multiple songs')
  .argument('[ids...]', '音乐ID列表 List of music IDs')
  .option('-f, --file <file>', '从文件读取ID列表 Read ID list from file')
  .action(async (ids: string[], options: { file?: string }) => {
    let musicIds = ids || [];

    if (options.file) {
      try {
        const fileContent = fs.readFileSync(options.file, 'utf8');
        const fileIds = fileContent.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
        musicIds = [...musicIds, ...fileIds];
      } catch (error) {
        console.error('读取文件失败 Failed to read file:', error);
        process.exit(1);
      }
    }

    musicIds = [...new Set(musicIds)];

    if (musicIds.length === 0) {
      console.error('请提供音乐ID Please provide music ID(s)');
      process.exit(1);
    }

    console.log(`准备下载 Preparing to download ${musicIds.length} 首歌曲 songs`);

    for (const id of musicIds) {
      await downloadSong(id, undefined, { autoProxy: program.opts().autoProxy });
    }

    console.log('\n所有下载任务完成！All download tasks completed!');
  });

program
  .command('album')
  .description('下载整张专辑 Download full album')
  .argument('<albumId>', '专辑ID或URL Album ID or URL')
  .action(async (albumId: string) => {
    await downloadAlbum(albumId, undefined, { autoProxy: program.opts().autoProxy });
  });

program
  .command('lyrics')
  .description('下载单个或多个音乐的歌词 Download lyrics for single or multiple songs')
  .argument('[ids...]', '音乐ID列表 List of music IDs')
  .option('-f, --file <file>', '从文件读取ID列表 Read ID list from file')
  .action(async (ids: string[], options: { file?: string }) => {
    let musicIds = ids || [];

    if (options.file) {
      try {
        const fileContent = fs.readFileSync(options.file, 'utf8');
        const fileIds = fileContent.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
        musicIds = [...musicIds, ...fileIds];
      } catch (error) {
        console.error('读取文件失败 Failed to read file:', error);
        process.exit(1);
      }
    }

    musicIds = [...new Set(musicIds)];

    if (musicIds.length === 0) {
      console.error('请提供音乐ID Please provide music ID(s)');
      process.exit(1);
    }

    console.log(`准备下载 Preparing to download lyrics for ${musicIds.length} 首歌曲 songs`);

    for (const id of musicIds) {
      await downloadSongLyrics(id);
    }

    console.log('\n所有歌词下载任务完成！All lyrics download tasks completed!');
  });

program
  .command('album-lyrics')
  .description('下载整张专辑的歌词 Download lyrics for full album')
  .argument('<albumId>', '专辑ID或URL Album ID or URL')
  .action(async (albumId: string) => {
    await downloadAlbumLyrics(albumId);
  });

program.parse();

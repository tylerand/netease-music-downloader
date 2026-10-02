import axios, { AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { Song, AlbumInfo } from '../types';
import { getAutoProxy } from './proxy';

// 网易云音乐 API 加密参数
const presetKey = '0CoJUm6Qyw8W8jud';
const iv = '0102030405060708';
const eapiKey = 'e82ckenh8dichen8';
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export let proxyConfig: AxiosRequestConfig | undefined;

export function setProxy(proxyUrl: string | undefined) {
  if (proxyUrl) {
    proxyConfig = {
      proxy: {
        protocol: proxyUrl.startsWith('https') ? 'https' : 'http',
        host: new URL(proxyUrl).hostname,
        port: parseInt(new URL(proxyUrl).port),
      }
    };
    console.log('代理已设置 Proxy configured:', proxyUrl);
  } else {
    proxyConfig = undefined;
  }
}

const GUEST_NMTID = '00OJ_vv9oqXwqq8TQFLFUbVeZz059kAAAGMqWD4yw';
const guestNuid = randomBytes(16).toString('hex');

let userCookie: string | undefined;
let cookieHintShown = false;

// 接受纯 MUSIC_U 值或完整 Cookie 字符串 Accept a bare MUSIC_U value or a full cookie string
export function normalizeCookie(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.replace(/[\r\n]+/g, ' ').trim();
  value = value.replace(/^cookie:\s*/i, '').replace(/^["']|["']$/g, '').trim();
  if (!value) return undefined;
  return value.includes('=') ? value : `MUSIC_U=${value}`;
}

// 优先级 Priority: --cookie > NETEASE_COOKIE > NETEASE_MUSIC_U
export function initCookie(cliValue?: string): void {
  const raw = cliValue || process.env.NETEASE_COOKIE || process.env.NETEASE_MUSIC_U;
  userCookie = normalizeCookie(raw);
  if (userCookie) {
    console.log('已使用自定义 Cookie Using user-provided cookie (value hidden)');
  }
}

export function hasUserCookie(): boolean {
  return !!userCookie;
}

function buildCookie(): string {
  const parts = userCookie ? [userCookie.replace(/;\s*$/, '')] : [];
  const hasName = (name: string) =>
    parts.some(part => part.split(';').some(kv => kv.trim().toLowerCase().startsWith(name.toLowerCase() + '=')));
  if (!hasName('NMTID')) parts.push(`NMTID=${GUEST_NMTID}`);
  if (!hasName('_ntes_nuid')) parts.push(`_ntes_nuid=${guestNuid}`);
  return parts.join('; ');
}

function getHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CloudMusic/2.5.1',
    'Referer': 'https://music.163.com/',
    'Origin': 'https://music.163.com',
    'Cookie': buildCookie(),
  };
}

// 未配置 Cookie 时只提示一次 Print a one-time hint when no cookie is configured
export function showCookieHintOnce(): void {
  if (userCookie || cookieHintShown) return;
  cookieHintShown = true;
  console.log('提示：当前未配置登录 Cookie，以游客身份访问，VIP/付费歌曲可能无法下载。可使用 --cookie <MUSIC_U> 或设置环境变量 NETEASE_MUSIC_U。\nHint: No login cookie configured (guest mode); VIP/paid songs may be unavailable. Use --cookie <MUSIC_U> or set the NETEASE_MUSIC_U env var.');
}

export function describeApiCode(code: number | string | undefined, message?: string): string {
  const base = `API 返回错误 API returned error: code=${code ?? 'unknown'}${message ? `, message=${message}` : ''}`;
  const c = Number(code);
  let hint = '';
  if (c === 301) {
    hint = hasUserCookie()
      ? '未登录或 Cookie 已失效，请重新获取 MUSIC_U。Not logged in or cookie invalid/expired; get a fresh MUSIC_U.'
      : '未登录，请使用 --cookie 提供 MUSIC_U。Not logged in; provide MUSIC_U via --cookie.';
  } else if (c === -460 || c === 403) {
    hint = '请求被风控拦截，可能是 IP 或地区受限（反爬）。Blocked by anti-bot, or your IP/region is restricted.';
  } else if (c === 404) {
    hint = '资源不存在或已下架。Resource not found or removed.';
  } else if (c === 429 || c === -447) {
    hint = '请求过于频繁，请稍后重试。Too many requests; retry later.';
  }
  return hint ? `${base}。${hint}` : base;
}

export function describeNetworkError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return describeApiCode(error.response.status, error.response.statusText) + ' (HTTP)';
    }
    const code = error.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      return '请求超时 Request timed out，请检查网络或使用 --auto-proxy。Check your network or use --auto-proxy.';
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
      return `网络连接失败 Network error (${code})，请检查网络/代理设置。Check your network/proxy settings.`;
    }
    return `网络请求失败 Network request failed: ${error.message}`;
  }
  return `未知错误 Unknown error: ${error instanceof Error ? error.message : String(error)}`;
}

// 根据 fee 字段解释无法获取 URL 的原因 Explain a null url using the fee field
function describeFee(fee: any): string | undefined {
  switch (Number(fee)) {
    case 1: return 'VIP 专属歌曲 VIP-only song (fee=1)';
    case 4: return '需单独购买数字专辑 Requires purchasing the album (fee=4)';
    case 8: return '高音质需要 VIP，普通音质可免费 High quality requires VIP (fee=8)';
    default: return undefined;
  }
}

export function formatUnavailableHelp(reason: string | undefined, autoProxy?: boolean): string {
  const lines = [reason || '未知原因 Unknown reason'];
  const steps: string[] = [];
  if (!hasUserCookie()) steps.push('--cookie <MUSIC_U>');
  if (!autoProxy) steps.push('--auto-proxy');
  if (steps.length) {
    lines.push(`建议 Suggestion: 尝试 try ${steps.join(' / ')}`);
  }
  return lines.join('\n');
}

// 音质等级，按优先级排序
const QUALITY_LEVELS = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
const QUALITY_BITRATES = {
  'standard': '128000',
  'higher': '192000',
  'exhigh': '320000',
  'lossless': '999000',
  'hires': '999000'
};

function getRandomString(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += base62[Math.floor(Math.random() * base62.length)];
  }
  return result;
}

function aesEncrypt(buffer: Buffer | string, mode: string, key: string, iv: string) {
  const keyBuffer = Buffer.from(key).slice(0, 16);
  const ivBuffer = Buffer.from(iv).slice(0, 16);
  const cipher = createCipheriv('aes-128-' + mode, keyBuffer, ivBuffer);
  cipher.setAutoPadding(true);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function eapi(url: string, obj: any) {
  const text = JSON.stringify(obj);
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = createHash('md5').update(message).digest('hex');
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return {
    params: aesEncrypt(data, 'ecb', eapiKey, '').toString('hex').toUpperCase()
  };
}

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const response = await axios({
      method: 'get',
      url,
      responseType: 'arraybuffer',
      ...proxyConfig
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('下载封面图片失败 Failed to download cover image:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

export async function getSongInfo(id: string): Promise<Song> {
  try {
    const url = '/api/v3/song/detail';
    const data = {
      c: JSON.stringify([{ id }]),
      header: {
        os: 'iOS',
        appver: '2.5.1',
        deviceId: randomBytes(8).toString('hex').toUpperCase(),
      }
    };

    const { params } = eapi(url, data);
    const response = await axios.post(
      'https://interface3.music.163.com/eapi/v3/song/detail',
      new URLSearchParams({
        params
      }).toString(),
      {
        headers: {
          ...getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'NeteaseMusic/2.5.1 (iPhone; iOS 16.6; Scale/3.00)'
        },
        ...proxyConfig
      }
    );

    const song = response.data?.songs?.[0];
    if (!song) throw new Error('获取歌曲信息失败 Failed to get song info');

    const artists = song.ar?.map((artist: any) => ({
      name: artist.name || '未知歌手 Unknown Artist'
    })) || [{ name: '未知歌手 Unknown Artist' }];

    return {
      id: song.id.toString(),
      name: `${song.name}${song.alia?.length ? ` (${song.alia[0]})` : ''}`,
      artists,
      album: {
        name: song.al?.name || '',
        picUrl: song.al?.picUrl
      },
      duration: song.dt, // duration in milliseconds
      publishTime: song.publishTime
    };
  } catch (error) {
    console.error('获取歌曲信息失败 Failed to get song info:', axios.isAxiosError(error) ? describeNetworkError(error) : (error instanceof Error ? error.message : 'Unknown error'));
    throw error; // 直接抛出错误，而不是返回默认值
  }
}

export async function getAlbumInfo(albumId: string): Promise<AlbumInfo> {
  try {
    const url = '/api/v1/album/' + albumId;
    const data = {
      header: {
        os: 'iOS',
        appver: '2.5.1',
        deviceId: randomBytes(8).toString('hex').toUpperCase(),
      }
    };

    const { params } = eapi(url, data);
    const response = await axios.post(
      'https://interface3.music.163.com/eapi/v1/album/' + albumId,
      new URLSearchParams({
        params
      }).toString(),
      {
        headers: {
          ...getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'NeteaseMusic/2.5.1 (iPhone; iOS 16.6; Scale/3.00)'
        }
      }
    );

    if (response.data?.code !== 200) {
      throw new Error(describeApiCode(response.data?.code, response.data?.message));
    }

    const album = response.data?.album;
    if (!album) {
      throw new Error('获取专辑信息失败 Failed to get album info');
    }

    const songs = response.data?.songs || [];
    const songList = songs.map((song: any) => {
      const artists = song.ar?.map((artist: any) => ({
        name: artist.name || '未知歌手 Unknown Artist'
      })) || [{ name: '未知歌手 Unknown Artist' }];

      return {
        id: song.id.toString(),
        name: `${song.name}${song.alia?.length ? ` (${song.alia[0]})` : ''}`,
        artists,
        album: {
          name: album.name || '',
          picUrl: album.picUrl
        },
        duration: song.dt,
        publishTime: song.publishTime
      };
    });

    const albumArtists = album.artists?.map((artist: any) => artist.name).filter(Boolean) || ['未知歌手 Unknown Artist'];
    const albumArtistName = albumArtists.join(',');

    return {
      songs: songList,
      albumName: album.name || '',
      artistName: albumArtistName,
      picUrl: album.picUrl,
      publishTime: album.publishTime
    };
  } catch (error) {
    console.error('获取专辑信息失败 Failed to get album info:', axios.isAxiosError(error) ? describeNetworkError(error) : (error instanceof Error ? error.message : 'Unknown error'));
    return {
      songs: [],
      albumName: '',
      artistName: '未知歌手 Unknown Artist'
    };
  }
}

interface SongUrlResult {
  url: string | null;
  reason?: string;
  // 接口级错误，换音质重试没有意义 API/network-level failure; other qualities will not help
  fatal?: boolean;
}

async function getSongUrl(id: string, level: string): Promise<SongUrlResult> {
  try {
    const url = '/api/song/enhance/player/url/v1';
    const data = {
      ids: [id],
      level,
      encodeType: 'aac',
      header: {
        os: 'iOS',
        appver: '2.5.1',
        deviceId: randomBytes(8).toString('hex').toUpperCase(),
      }
    };

    const { params } = eapi(url, data);
    const response = await axios.post(
      'https://interface3.music.163.com/eapi/song/enhance/player/url/v1',
      new URLSearchParams({
        params
      }).toString(),
      {
        headers: {
          ...getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'NeteaseMusic/2.5.1 (iPhone; iOS 16.6; Scale/3.00)'
        },
        timeout: 10000,
        ...proxyConfig
      }
    );

    if (response.data?.code !== 200) {
      return { url: null, fatal: true, reason: describeApiCode(response.data?.code, response.data?.message) };
    }

    const songData = response.data?.data?.[0];
    if (!songData?.url) {
      const details: string[] = [];
      const feeText = describeFee(songData?.fee);
      if (feeText) details.push(feeText);
      if (songData?.freeTrialInfo) details.push('仅支持试听 Only a free trial is offered (freeTrialInfo present)');
      if (songData?.code !== undefined && songData.code !== 200) {
        const itemCode = Number(songData.code);
        if (itemCode === -110 || itemCode === 404) details.push(`无版权或已下架 No copyright / removed (item code=${songData.code})`);
        else if (itemCode === 403 || itemCode === -460) details.push(`访问被拒绝，可能是 IP/地区限制 Access denied, possibly IP/region restriction (item code=${songData.code})`);
        else details.push(`item code=${songData.code}`);
      }
      const causes = '可能原因 Possible causes: 游客/未登录 guest or not logged in; VIP/付费专属 VIP-only or paid; 地区/IP 限制 region/IP restriction; 无版权 no copyright';
      const reason = `接口返回 200 但没有下载链接 API returned 200 but no download URL for ${level}${details.length ? ` (${details.join('; ')})` : ''}。${causes}`;
      return { url: null, reason };
    }

    if (songData.freeTrialInfo) {
      console.log('警告：该链接可能仅为试听片段 Warning: this URL may be a trial clip only');
    }

    console.log(`获取到音质 Quality: ${level}, 比特率 Bitrate: ${Math.floor(songData.br / 1000)}kbps, 格式 Format: ${songData.type}, URL: ${songData.url}`);
    return { url: songData.url };
  } catch (error) {
    return { url: null, fatal: true, reason: describeNetworkError(error) };
  }
}

export async function checkSongAvailability(id: string): Promise<{
  available: boolean;
  contentLength?: number;
  url?: string;
  quality?: string;
  bitrate?: number;
  type?: string;
  reason?: string;
}> {
  let reason: string | undefined;
  // 尝试获取最高音质
  for (const level of QUALITY_LEVELS) {
    const result = await getSongUrl(id, level);
    if (!result.url) {
      reason = reason || result.reason;
      if (result.fatal) break;
      continue;
    }
    const url = result.url;
    try {
      const response = await axios.head(url, {
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400,
        headers: {
          ...getHeaders(),
          'Referer': 'https://music.163.com/'
        },
        timeout: 10000,
        ...proxyConfig
      });

      const contentLength = parseInt(response.headers['content-length'], 10);
      if (contentLength > 500 * 1024) { // 大于 500KB
        return {
          available: true,
          contentLength,
          url,
          quality: level,
          bitrate: Math.floor(contentLength * 8 / (response.headers['content-duration'] || 300) / 1000), // 估算比特率
          type: url.split('.').pop()?.split('?')[0]
        };
      }
      reason = reason || `文件过小，可能是试听片段 File too small (${Number.isNaN(contentLength) ? 'unknown' : contentLength} bytes), possibly a trial clip (${level})`;
    } catch (error) {
      reason = reason || `HEAD 检查失败 HEAD check failed (${level}): ${describeNetworkError(error)}`;
    }
  }

  return { available: false, reason };
}

export async function getLyrics(id: string): Promise<string | null> {
  try {
    const url = '/api/song/lyric/v1';
    const data = {
      id,
      lv: 1,
      kv: 1,
      tv: -1,
      header: {
        os: 'iOS',
        appver: '2.5.1',
        deviceId: randomBytes(8).toString('hex').toUpperCase(),
      }
    };

    const { params } = eapi(url, data);
    const apiUrl = 'https://interface3.music.163.com/eapi/song/lyric/v1';
    console.log('歌词链接 Lyrics URL:', `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`);

    const response = await axios.post(
      apiUrl,
      new URLSearchParams({
        params
      }).toString(),
      {
        headers: {
          ...getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'NeteaseMusic/2.5.1 (iPhone; iOS 16.6; Scale/3.00)'
        },
        ...proxyConfig
      }
    );

    if (response.data?.code !== 200) {
      console.error('获取歌词失败 Failed to get lyrics:', describeApiCode(response.data?.code, response.data?.message));
      return null;
    }

    const lrc = response.data?.lrc?.lyric;
    if (!lrc) {
      console.log('该歌曲无歌词 No lyrics available for this song');
      return null;
    }

    return lrc;
  } catch (error) {
    console.error('获取歌词失败 Failed to get lyrics:', describeNetworkError(error));
    return null;
  }
}

export async function checkSongAvailabilityWithRetry(id: string, autoProxy?: boolean): Promise<{
  available: boolean;
  contentLength?: number;
  url?: string;
  needProxy?: boolean;
  quality?: string;
  bitrate?: number;
  type?: string;
  reason?: string;
}> {
  showCookieHintOnce();
  let reason: string | undefined;
  // 先尝试直连
  console.log('尝试直连下载 Trying direct connection...');
  const originalProxy = proxyConfig;
  setProxy(undefined);

  try {
    const result = await checkSongAvailability(id);
    if (result.available) {
      console.log('直连成功 Direct connection successful');
      return { ...result, needProxy: false };
    }
    reason = result.reason;
    console.log('直连失败 Direct connection failed:', reason || 'unknown');
  } catch (error) {
    reason = describeNetworkError(error);
    console.log('直连失败 Direct connection failed:', reason);
  }

  // 如果直连失败且启用了自动代理，尝试寻找可用代理
  if (autoProxy) {
    console.log('正在寻找可用的代理服务器 Finding available proxy server...');
    const proxyUrl = await getAutoProxy();
    if (proxyUrl) {
      try {
        const result = await checkSongAvailability(id);
        if (!result.available) {
          reason = result.reason || reason;
          console.log('代理连接也失败了 Proxy connection also failed:', result.reason || 'unknown');
        }
        return { ...result, needProxy: true, reason: result.available ? undefined : reason };
      } catch (error) {
        reason = describeNetworkError(error);
        console.log('代理连接也失败了 Proxy connection also failed:', reason);
      }
    } else {
      console.log('未找到可用的代理服务器 No available proxy found');
    }
  }
  // 如果有预设的代理配置，尝试使用
  else if (originalProxy?.proxy && typeof originalProxy.proxy !== 'boolean') {
    console.log('尝试使用预设代理 Trying with preset proxy...');
    const proxyUrl = `${originalProxy.proxy.protocol}://${originalProxy.proxy.host}:${originalProxy.proxy.port}`;
    setProxy(proxyUrl);
    try {
      const result = await checkSongAvailability(id);
      if (!result.available) {
        reason = result.reason || reason;
        console.log('代理连接也失败了 Proxy connection also failed:', result.reason || 'unknown');
      }
      return { ...result, needProxy: true, reason: result.available ? undefined : reason };
    } catch (error) {
      reason = describeNetworkError(error);
      console.log('代理连接也失败了 Proxy connection also failed:', reason);
    }
  }

  return { available: false, needProxy: false, reason };
}

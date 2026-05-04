import { APIResource } from '../resource.js';

export interface RecordingDownload {
  /** WAV 바이너리 데이터 (PCM 16bit mono 8kHz) */
  data: ArrayBuffer;
  /** 응답의 Content-Type (예: 'audio/wav') */
  contentType: string;
  /** Content-Disposition 헤더에서 파싱한 파일명 (없으면 null) */
  filename: string | null;
}

function parseFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=(?:[\w-]+'[^']*')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to plain filename
    }
  }
  const quoted = disposition.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const bare = disposition.match(/filename=([^;]+)/i);
  return bare ? bare[1].trim() : null;
}

export class Recordings extends APIResource {
  /**
   * 통화 녹음(WAV)을 다운로드합니다.
   *
   * 콘솔과 동일한 서버측 MixMonitor 원본 (PCM 16bit mono 8kHz).
   *
   * @throws NotFoundError (404) — 통화가 없거나 녹음이 없음(`recordingUrl: null`).
   * @throws PermissionDeniedError (403) — accountId 불일치.
   */
  async download(
    callId: string,
    options: {
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<RecordingDownload> {
    const response = await this._client._getRaw(
      `${this._basePath}/recordings/${callId}`,
      options,
    );
    const data = await response.arrayBuffer();
    return {
      data,
      contentType: response.headers.get('content-type') ?? 'audio/wav',
      filename: parseFilename(response.headers.get('content-disposition')),
    };
  }
}

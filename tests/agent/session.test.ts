import { describe, it, expect, vi } from 'vitest';
import { CallSession, DtmfCollectorBusyError } from '../../src/agent/session.js';

describe('CallSession', () => {
  function makeSession() {
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const hangup = vi.fn();
    const session = new CallSession({
      callId: 'CA123',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'inbound',
    });
    session._bindTransport(sendAudio, clearAudio, hangup);
    return { session, sendAudio, clearAudio, hangup };
  }

  it('initializes with call metadata', () => {
    const { session } = makeSession();
    expect(session.callId).toBe('CA123');
    expect(session.fromNumber).toBe('07012341234');
    expect(session.toNumber).toBe('01012345678');
    expect(session.accountId).toBe('AC123');
    expect(session.direction).toBe('inbound');
  });

  it('starts with ringing status before transport bind', () => {
    const session = new CallSession({
      callId: 'CA999',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'inbound',
    });
    expect(session.status).toBe('ringing');
  });

  it('becomes active after binding transport', () => {
    const { session } = makeSession();
    expect(session.status).toBe('active');
  });

  it('sends audio via bound transport function', () => {
    const { session, sendAudio } = makeSession();
    const audio = Buffer.from([1, 2, 3]);
    session.sendAudio(audio);
    expect(sendAudio).toHaveBeenCalledWith(audio);
  });

  it('clears audio via bound transport function', () => {
    const { session, clearAudio } = makeSession();
    session.clearAudio();
    expect(clearAudio).toHaveBeenCalled();
  });

  it('hangs up via bound transport function', () => {
    const { session, hangup } = makeSession();
    session.hangup();
    expect(hangup).toHaveBeenCalled();
  });

  it('emits events and invokes handlers', () => {
    const { session } = makeSession();
    const handler = vi.fn();
    session.on('transcript', handler);
    session._emit('transcript', 'user', 'hello');
    // Handler receives (call, ...args) matching Python SDK
    expect(handler).toHaveBeenCalledWith(session, 'user', 'hello');
  });

  it('marks session as ended and resolves wait()', async () => {
    const { session } = makeSession();

    session._markEnded();

    expect(session.status).toBe('ended');
    await session.wait(); // should resolve immediately
  });

  it('has a duration property', () => {
    const { session } = makeSession();
    expect(typeof session.duration).toBe('number');
    expect(session.duration).toBeGreaterThanOrEqual(0);
  });

  it('does not throw when sendAudio called without transport', () => {
    const session = new CallSession({
      callId: 'CA999',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'outbound',
    });
    expect(() => session.sendAudio(Buffer.from([1]))).not.toThrow();
  });
});

describe('CallSession DTMF', () => {
  function makeSession() {
    return new CallSession({
      callId: 'CA_test',
      fromNumber: '010',
      toNumber: '070',
      accountId: 'AC',
      direction: 'inbound',
    });
  }

  describe('sendDtmfSequence', () => {
    it('sends individual digits', async () => {
      const session = makeSession();
      const sent: string[] = [];
      session._sendDtmfFn = async (d: string) => { sent.push(d); };
      session._isTransportConnected = () => true;

      await session.sendDtmfSequence('123');
      expect(sent).toEqual(['1', '2', '3']);
    });

    it('throws on invalid character', async () => {
      const session = makeSession();
      session._sendDtmfFn = async () => {};
      session._isTransportConnected = () => true;

      await expect(session.sendDtmfSequence('1A')).rejects.toThrow('유효하지 않은 DTMF 문자');
    });
  });

  describe('collectDtmf', () => {
    it('collects up to max_digits', async () => {
      const session = makeSession();

      setTimeout(() => {
        session._routeDtmf('1');
        session._routeDtmf('2');
        session._routeDtmf('3');
      }, 50);

      const result = await session.collectDtmf({ maxDigits: 3, timeout: 2 });
      expect(result).toBe('123');
    });

    it('stops on finish key', async () => {
      const session = makeSession();

      setTimeout(() => {
        session._routeDtmf('1');
        session._routeDtmf('2');
        session._routeDtmf('#');
      }, 50);

      const result = await session.collectDtmf({ maxDigits: 10, finishOnKey: '#', timeout: 2 });
      expect(result).toBe('12');
    });

    it('returns empty on timeout', async () => {
      const session = makeSession();
      const result = await session.collectDtmf({ maxDigits: 4, timeout: 0.1 });
      expect(result).toBe('');
    });

    it('throws on double collect', async () => {
      const session = makeSession();

      const p = session.collectDtmf({ maxDigits: 4, timeout: 1 });

      await expect(session.collectDtmf({ maxDigits: 4, timeout: 1 }))
        .rejects.toThrow('이미 DTMF 수집 중');

      // Clean up
      session._routeDtmf('1');
      session._routeDtmf('2');
      session._routeDtmf('3');
      session._routeDtmf('4');
      await p;
    });

    it('중복 호출은 busy 예외로 구분된다', async () => {
      // 맨 Error 로 던지면 도구 래퍼가 "Error: ..." 로 감싸 모델에게 돌려주고, 모델은
      // 도구가 망가진 줄 알고 그 뒤로 다시 부르지 않는다 — 그때부터 키가 유실된다.
      const session = makeSession();
      const p = session.collectDtmf({ maxDigits: 3, timeout: 1 });

      await expect(session.collectDtmf({ maxDigits: 3, timeout: 1 })).rejects.toBeInstanceOf(
        DtmfCollectorBusyError,
      );

      session._routeDtmf('1');
      session._routeDtmf('2');
      session._routeDtmf('3');
      expect(await p).toBe('123');
    });

    it('수집값을 로그에 쓰지 않는다', async () => {
      // 키패드로 받는 값은 카드번호일 수 있다 — 자릿수만 남아야 한다.
      const logged: unknown[][] = [];
      const session = makeSession();
      session.setLogger({
        info: (...args: unknown[]) => logged.push(args),
        error: () => {},
        warn: () => {},
        debug: () => {},
      } as never);

      setTimeout(() => '4111'.split('').forEach((d) => session._routeDtmf(d)), 20);
      expect(await session.collectDtmf({ maxDigits: 4, timeout: 1 })).toBe('4111');

      const flat = JSON.stringify(logged);
      expect(flat).not.toContain('4111');
      expect(flat).toContain('4');
    });

    it('전체 상한이 자리마다 리셋되는 타이머를 끊는다', async () => {
      // inter-digit 타이머만 있으면 maxDigits × timeout 만큼 산다(11자리·5초 = 55초).
      const session = makeSession();
      const started = Date.now();

      // 자리 사이 간격(150ms)은 timeout(10초) 안이라 inter-digit 만으로는 안 끝난다.
      setTimeout(() => session._routeDtmf('1'), 150);
      setTimeout(() => session._routeDtmf('2'), 300);

      const result = await session.collectDtmf({
        maxDigits: 11,
        timeout: 10,
        maxWait: 0.5,
      });

      expect(result).toBe('12');
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('진 타이머를 지운다 — 이벤트 루프를 붙잡지 않는다', async () => {
      // Promise.race 는 진 promise 를 취소하지 않는다. clearTimeout 이 없으면 자리마다
      // 타이머가 살아남아 최대 timeout 초 동안 프로세스가 종료되지 않는다.
      const session = makeSession();
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

      setTimeout(() => '123'.split('').forEach((d) => session._routeDtmf(d)), 20);
      expect(await session.collectDtmf({ maxDigits: 3, timeout: 30 })).toBe('123');

      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      expect(after).toBeLessThanOrEqual(before);
    });
  });
});

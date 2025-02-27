import delay from 'delay';
import { Response } from 'got';
import got from '../../../lib/util/got';
import { api } from '../../../lib/platform/github/gh-got-wrapper';

jest.mock('../../../lib/util/got');
jest.mock('delay');

const get: <T extends object = any>(
  path: string,
  options?: any,
  okToRetry?: boolean
) => Promise<Response<T>> = api as any;

describe('platform/gh-got-wrapper', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete global.appMode;
    (delay as any).mockImplementation(() => Promise.resolve());
  });
  it('supports app mode', async () => {
    global.appMode = true;
    await api.get('some-url', { headers: { accept: 'some-accept' } });
    expect(got.mock.calls[0][1].headers.accept).toBe(
      'application/vnd.github.machine-man-preview+json, some-accept'
    );
  });
  it('strips v3 for graphql', async () => {
    got.mockImplementationOnce(() => ({
      body: '{"data":{',
    }));
    api.setBaseUrl('https://ghe.mycompany.com/api/v3/');
    await api.post('graphql', {
      body: 'abc',
    });
    expect(got.mock.calls[0][0].includes('/v3')).toBe(false);
  });
  it('paginates', async () => {
    got.mockReturnValueOnce({
      headers: {
        link:
          '<https://api.github.com/search/code?q=addClass+user%3Amozilla&page=2>; rel="next", <https://api.github.com/search/code?q=addClass+user%3Amozilla&page=3>; rel="last"',
      },
      body: ['a'],
    });
    got.mockReturnValueOnce({
      headers: {
        link:
          '<https://api.github.com/search/code?q=addClass+user%3Amozilla&page=3>; rel="next", <https://api.github.com/search/code?q=addClass+user%3Amozilla&page=3>; rel="last"',
      },
      body: ['b', 'c'],
    });
    got.mockReturnValueOnce({
      headers: {},
      body: ['d'],
    });
    const res = await api.get('some-url', { paginate: true });
    expect(res.body).toEqual(['a', 'b', 'c', 'd']);
    expect(got).toHaveBeenCalledTimes(3);
  });
  it('attempts to paginate', async () => {
    got.mockReturnValueOnce({
      headers: {
        link:
          '<https://api.github.com/search/code?q=addClass+user%3Amozilla&page=34>; rel="last"',
      },
      body: ['a'],
    });
    got.mockReturnValueOnce({
      headers: {},
      body: ['b'],
    });
    const res = await api.get('some-url', { paginate: true });
    expect(res.body).toHaveLength(1);
    expect(got).toHaveBeenCalledTimes(1);
  });
  it('should throw rate limit exceeded', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        statusCode: 403,
        message:
          'Error updating branch: API rate limit exceeded for installation ID 48411. (403)',
      })
    );
    await expect(api.get('some-url')).rejects.toThrow();
  });
  it('should throw Bad credentials', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        statusCode: 401,
        message: 'Bad credentials. (401)',
      })
    );
    let e;
    try {
      await api.get('some-url');
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();
    expect(e.message).toEqual('bad-credentials');
  });
  it('should throw platform failure', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        statusCode: 401,
        message: 'Bad credentials. (401)',
        headers: {
          'x-ratelimit-limit': '60',
        },
      })
    );
    let e;
    try {
      await api.get('some-url');
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();
    expect(e.message).toEqual('platform-failure');
  });
  it('should throw platform failure ENOTFOUND', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        name: 'RequestError',
        code: 'ENOTFOUND',
      })
    );
    let e;
    try {
      await get('some-url', {}, false);
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();
    expect(e.message).toEqual('platform-failure');
  });
  it('should throw platform failure for 500', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        statusCode: 500,
        message: 'Internal Server Error',
      })
    );
    let e;
    try {
      await get('some-url', {}, false);
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();
    expect(e.message).toEqual('platform-failure');
  });
  it('should throw platform failure ParseError', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        name: 'ParseError',
      })
    );
    let e;
    try {
      await get('some-url', {}, false);
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();
    expect(e.message).toEqual('platform-failure');
  });
  it('should throw for unauthorized integration', async () => {
    got.mockImplementationOnce(() =>
      Promise.reject({
        statusCode: 403,
        message: 'Resource not accessible by integration (403)',
      })
    );
    let e;
    try {
      await get('some-url', {}, false);
    } catch (err) {
      e = err;
    }
    expect(e).toBeDefined();
    expect(e.message).toEqual('integration-unauthorized');
  });
});

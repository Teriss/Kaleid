const { keepServerErrorsLogged, waitUntilListening } = require('../backendLifecycle.cjs');

// electron/qq/qqApiStartup.cjs
//
// Starts @yakult-green-tea/qq-music-api inside the Electron main process. The package is a regular
// production dependency, so npm nests its own ws@7 under it and the app's ws@8 is left alone.

const QQ_API_MODULE = '@yakult-green-tea/qq-music-api';

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return typeof error === 'string' && error.trim() ? error : 'Unknown error';
}

// A missing package is a packaging problem the user can act on; anything else (a port that is
// already taken, a throw from inside the package) is a runtime failure. Callers map the two to
// different statuses, so the distinction must survive the throw.
function isModuleNotFound(error) {
  return Boolean(error) && error.code === 'MODULE_NOT_FOUND';
}

// The package calls app.listen() while it is being required, so require() returns before the socket
// is bound. Resolving only on 'listening' (waitUntilListening) keeps the caller from reporting "running"
// against a port that may still fail to bind; a bind failure arrives as a rejection rather than an
// unhandled event on the server.

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
}

// The package listens on import and reads PORT at config load, so the environment is prepared first
// and restored afterwards to keep the main process environment untouched.
//
// ⚠️ Call this at most once per process. require() caches modules, so a second call would not start
// a second server: it would return the cached module, i.e. the *previous* server bound to the
// *previous* port, while reporting the port passed in this time. Do not add a retry path here
// without first solving the cache (there is no supported way to re-listen on the exported server).
async function startQqApi(options = {}) {
  const {
    port,
    stateFilePath,
    authSessionRepository,
    getRequestAgents,
    moduleId = QQ_API_MODULE,
    loadModule = (target) => require(target),
    env = process.env,
  } = options;

  if (!port) {
    throw new Error('A port is required to start the QQ API');
  }

  const previous = {
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    AUTO_OPEN_EXPLORER: env.AUTO_OPEN_EXPLORER,
    QQ_AUTH_STATE_PATH: env.QQ_AUTH_STATE_PATH,
    QQ_DISABLE_UPDATE_CHECK: env.QQ_DISABLE_UPDATE_CHECK,
  };

  const restore = () => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    });
  };

  env.PORT = String(port);
  env.AUTO_OPEN_EXPLORER = 'false';
  env.QQ_DISABLE_UPDATE_CHECK = 'true';
  if (stateFilePath) {
    env.QQ_AUTH_STATE_PATH = stateFilePath;
  }

  let qqApi;
  try {
    // Yingjian adaptation: this in-process server never listens on LAN interfaces.
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    let axios;
    let axiosCreate;
    if (typeof getRequestAgents === 'function') {
      const packageJson = require.resolve(`${moduleId}/package.json`);
      const packageRequire = require('node:module').createRequire(packageJson);
      axios = packageRequire('axios');
      axiosCreate = axios.create;
      const instrumentClient = (client) => {
        client.interceptors.request.use(async (config) => {
          const target = new URL(String(config.url || ''), config.baseURL).href;
          const agents = await getRequestAgents(target);
          config.proxy = false;
          if (agents.httpAgent) config.httpAgent = agents.httpAgent;
          if (agents.httpsAgent) config.httpsAgent = agents.httpsAgent;
          config.__kaleidProxyDispose = agents.dispose;
          return config;
        });
        const release = (config) => {
          const dispose = config && config.__kaleidProxyDispose;
          if (typeof dispose === 'function') dispose();
          if (config) delete config.__kaleidProxyDispose;
        };
        client.interceptors.response.use((response) => {
          release(response.config);
          return response;
        }, (error) => {
          release(error.config);
          throw error;
        });
        return client;
      };
      const createRoutedClient = function (...args) {
        return instrumentClient(Reflect.apply(axiosCreate, this, args));
      };
      axios.create = createRoutedClient;

      // QR login creates an Axios client for each login session, after the HTTP server has
      // loaded. Wrap the package-private factory so those later clients get the same route.
      const authHttpClientPath = require('node:path').join(
        require('node:path').dirname(packageJson),
        'dist/src/services/auth/httpClient.js',
      );
      const authHttpClientModule = packageRequire(authHttpClientPath);
      const createAuthHttpClient = authHttpClientModule.default;
      authHttpClientModule.default = function (...args) {
        const currentCreate = axios.create;
        axios.create = createRoutedClient;
        try {
          return Reflect.apply(createAuthHttpClient, this, args);
        } finally {
          axios.create = currentCreate;
        }
      };

      const wsPath = packageRequire.resolve('ws');
      const WebSocket = packageRequire('ws');
      const routedAgent = new (class extends http.Agent {
        constructor() {
          super({ keepAlive: false });
        }
        addRequest(request, requestOptions) {
          const protocol = requestOptions.protocol || 'https:';
          const hostname = requestOptions.hostname || requestOptions.host;
          const authority = hostname.includes(':') && !hostname.startsWith('[')
            ? `[${hostname}]`
            : hostname;
          const target = `${protocol}//${authority}${requestOptions.port ? `:${requestOptions.port}` : ''}${requestOptions.path || '/'}`;
          Promise.resolve(getRequestAgents(target)).then((agents) => {
            const agent = protocol === 'https:' ? agents.httpsAgent : agents.httpAgent;
            let socketSeen = false;
            let released = false;
            const release = () => {
              if (released) return;
              released = true;
              agents.dispose?.();
            };
            request.once('socket', (socket) => {
              socketSeen = true;
              socket.once('close', release);
            });
            request.once('error', () => { if (!socketSeen) release(); });
            request.once('close', () => { if (!socketSeen) release(); });
            request.agent = agent || (protocol === 'https:' ? require('node:https').globalAgent : http.globalAgent);
            request.agent.addRequest(request, requestOptions);
          }).catch((error) => request.destroy(error));
        }
      })();
      class RoutedWebSocket extends WebSocket {
        constructor(address, protocols, options) {
          if (protocols && typeof protocols === 'object' && !Array.isArray(protocols)) {
            options = protocols;
            protocols = undefined;
          }
          super(address, protocols, { ...(options || {}), agent: routedAgent });
        }
      }
      const cachedWs = require.cache[wsPath];
      if (cachedWs) cachedWs.exports = RoutedWebSocket;
    }
    http.Server.prototype.listen = function (...args) {
      if (args[0] === port && (args[1] === undefined || typeof args[1] === 'function')) args.splice(1, 0, '127.0.0.1');
      return Reflect.apply(listen, this, args);
    };
    try { qqApi = loadModule(moduleId); } finally {
      http.Server.prototype.listen = listen;
      if (axios && axiosCreate) axios.create = axiosCreate;
    }
    if (authSessionRepository) {
      const configureAuthSessionRepository = qqApi && (
        qqApi.configureAuthSessionRepository ||
        (qqApi.default && qqApi.default.configureAuthSessionRepository)
      );
      if (typeof configureAuthSessionRepository !== 'function') {
        throw new Error(
          `QQ API package ${moduleId} does not support auth session persistence`,
        );
      }
      // require() starts the server, but Node cannot accept an HTTP request until this synchronous
      // stack returns. Injecting here restores encrypted credentials before the first status probe.
      configureAuthSessionRepository(authSessionRepository);
    }
  } catch (error) {
    if (isModuleNotFound(error)) {
      const missing = new Error(
        `QQ API package ${moduleId} is not installed. Run: npm install`,
        { cause: error },
      );
      missing.code = 'MODULE_NOT_FOUND';
      throw missing;
    }

    throw error;
  } finally {
    restore();
  }

  const server = qqApi && (qqApi.server || (qqApi.default && qqApi.default.server));
  if (!server || typeof server.once !== 'function') {
    throw new Error(
      `QQ API package ${moduleId} did not expose an HTTP server`,
    );
  }

  await waitUntilListening(server);

  // Once bound, later socket errors must not take the main process down with an unhandled 'error'.
  keepServerErrorsLogged(server, 'QQ API');

  return {
    port,
    stateFilePath: stateFilePath || null,
    server,
    close: () => closeServer(server),
  };
}

module.exports = {
  QQ_API_MODULE,
  getErrorMessage,
  isModuleNotFound,
  startQqApi,
};

import { useEffect, useRef, useState } from 'react';
import './App.scss';

const PRICE = Number(import.meta.env.VITE_PRICE) || 10;
const NAMETAG = import.meta.env.VITE_NAMETAG || 'textcreator';
const NETWORK = import.meta.env.VITE_NETWORK || 'testnet2';
const WALLET_URL = import.meta.env.VITE_WALLET_URL || 'https://sphere.unicity.network';

const SESSION_KEY = 'textcreator:connect-session';

// Verified facts from @unicitylabs/sphere-sdk v0.14.9 (dist/connect):
// - Connect Protocol v2.1; only SPHERE_NETWORKS.testnet2 = { id: 4 } is exported.
// - UCT testnet2 coinId is lowercase 64-hex; the 'UCT' symbol itself is rejected by wallets.
// - Amounts are transferred as decimal strings in base units; UCT has 6 decimals.
const UCT_COIN_ID_TESTNET2 = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';
const PRICE_MICRO = BigInt(Math.round(PRICE * 1e6)).toString();

const WALLET_ERRORS = {
  4003: 'The connection request was rejected in the wallet.',
  4007: 'Unsupported wallet version. Open or update sphere.unicity.network and try again.',
  4008: 'Network mismatch: this page targets Unicity testnet2. Switch your wallet network.',
  4009: 'The wallet is locked. Unlock it and try again.',
  4200: 'Payment was cancelled in the wallet.',
  4201: 'Outcome unknown. Check the wallet balance before paying again.',
};

function describeError(err) {
  return WALLET_ERRORS[err?.code] || err?.message || 'Something went wrong';
}

function formatUct(micro) {
  const whole = micro / 1000000n;
  const frac = (micro % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function extractUctBalance(result) {
  const assets = Array.isArray(result) ? result : (result?.assets ?? []);
  const uct = assets.find((a) => a?.coinId === UCT_COIN_ID_TESTNET2 || a?.symbol === 'UCT');
  if (!uct) return '0.00';
  const raw = uct.confirmedAmount ?? uct.totalAmount ?? '0';
  return formatUct(BigInt(raw));
}

function App() {
  const clientRef = useRef(null);
  const [status, setStatus] = useState('disconnected'); // disconnected | connecting | connected
  const [identity, setIdentity] = useState(null);       // PublicIdentity: chainPubkey, nametag?, directAddress?
  const [uctBalance, setUctBalance] = useState(null);   // formatted string | null
  const [walletError, setWalletError] = useState(null);
  const [payState, setPayState] = useState('idle');     // idle | confirming | done | error
  const [payInfo, setPayInfo] = useState(null);

  const loadSphereConnect = () =>
    Promise.all([
      import('@unicitylabs/sphere-sdk/connect'),
      import('@unicitylabs/sphere-sdk/connect/browser'),
    ]);

  const refreshBalance = async (client) => {
    try {
      const result = await client.query('sphere_getAssets');
      setUctBalance(extractUctBalance(result));
    } catch {
      setUctBalance(null);
    }
  };

  const attachEvents = (client, connectSdk) => {
    const { WALLET_EVENTS } = connectSdk;
    client.on(WALLET_EVENTS.UNLOCKED, (payload) => {
      if (payload && typeof payload === 'object' && payload.chainPubkey) {
        setIdentity(payload);
        refreshBalance(client);
      }
    });
    client.on(WALLET_EVENTS.IDENTITY_CHANGED, (payload) => {
      if (payload && typeof payload === 'object' && payload.chainPubkey) {
        setIdentity(payload);
      }
      refreshBalance(client);
    });
    client.on(WALLET_EVENTS.DISCONNECTED, () => {
      clientRef.current = null;
      setIdentity(null);
      setUctBalance(null);
      setStatus('disconnected');
      setPayState('idle');
      setPayInfo(null);
      sessionStorage.removeItem(SESSION_KEY);
    });
    // wallet:locked — the session STAYS ALIVE; nothing to clean up.
    client.on(WALLET_EVENTS.LOCKED, () => {});
  };

  const performConnect = async (resumeSessionId, silent) => {
    const [connectSdk, connectBrowserSdk] = await loadSphereConnect();
    const { SPHERE_NETWORKS, RPC_METHODS, PERMISSION_SCOPES, INTENT_ACTIONS } = connectSdk;
    const { autoConnect } = connectBrowserSdk;

    const network = SPHERE_NETWORKS[NETWORK] ?? SPHERE_NETWORKS.testnet2;
    const result = await autoConnect({
      dapp: { name: 'TextCreator', url: window.location.origin },
      walletUrl: WALLET_URL,
      network,
      permissions: [
        PERMISSION_SCOPES.IDENTITY_READ,
        PERMISSION_SCOPES.BALANCE_READ,
        PERMISSION_SCOPES.TOKENS_READ,
        PERMISSION_SCOPES.TRANSFER_REQUEST,
      ],
      timeout: 30000,
      intentTimeout: 120000,
      ...(resumeSessionId ? { resumeSessionId, silent: silent ?? true } : {}),
    });

    clientRef.current = result.client;
    sessionStorage.setItem(SESSION_KEY, result.connection.sessionId);
    attachEvents(result.client, connectSdk);
    setStatus('connected');
    setWalletError(null);

    const ident = result.client.walletIdentity ?? result.connection.identity ?? null;
    setIdentity(ident);

    if (result.client.walletLocked) {
      setUctBalance(null); // balance query answers 4009 until the wallet is unlocked
    } else {
      await refreshBalance(result.client);
    }

    return { RPC_METHODS, INTENT_ACTIONS };
  };

  const connect = async () => {
    setStatus('connecting');
    setWalletError(null);
    try {
      await performConnect();
    } catch (err) {
      setStatus('disconnected');
      sessionStorage.removeItem(SESSION_KEY);
      setWalletError(describeError(err));
    }
  };

  const resumeSession = async () => {
    const sessionId = sessionStorage.getItem(SESSION_KEY);
    if (!sessionId) return;
    setStatus('connecting');
    try {
      await performConnect(sessionId, true);
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      setStatus('disconnected');
    }
  };

  // Restore the previous session on page load (silent: no popup if the wallet
  // has not previously approved this origin).
  const resumeTried = useRef(false);
  useEffect(() => {
    if (resumeTried.current) return; // StrictMode double-invoke guard
    resumeTried.current = true;
    resumeSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = async () => {
    try {
      await clientRef.current?.disconnect();
    } catch {
      // ignore — local cleanup below is enough
    }
    clientRef.current = null;
    sessionStorage.removeItem(SESSION_KEY);
    setIdentity(null);
    setUctBalance(null);
    setStatus('disconnected');
    setPayState('idle');
    setPayInfo(null);
    setWalletError(null);
  };

  const pay = async () => {
    const client = clientRef.current;
    if (!client || payState === 'confirming') return;
    setPayState('confirming');
    setPayInfo(null);
    setWalletError(null);
    try {
      const result = await client.intent('send', {
        // Wallets accept either alias; both are sent for compatibility.
        to: `@${NAMETAG}`,
        recipient: `@${NAMETAG}`,
        amount: PRICE_MICRO,
        coinId: UCT_COIN_ID_TESTNET2,
      });
      setPayState('done');
      setPayInfo(result?.transferId ?? null);
      await refreshBalance(client);
    } catch (err) {
      setPayState('error');
      setWalletError(describeError(err));
    }
  };

  const walletLabel = identity?.nametag ? `@${identity.nametag}` : null;
  const shortAddress = identity
    ? (identity.nametag ? null : `${identity.chainPubkey.slice(0, 8)}…${identity.chainPubkey.slice(-6)}`)
    : null;

  return (
    <div className="page">
      <div className="card">
        <div className="header">
          <div className="avatar" role="img" aria-label="TextCreator logo">📝</div>
          <div className="info">
            <h1>TextCreator</h1>
            <div className="nametag">@{NAMETAG}</div>
          </div>
        </div>

        <p className="description">
          I write quality copy of any kind for UCT.
          Posts, sales copy, headlines, stories, letters, scripts and more.
        </p>

        <div className="section wallet">
          <h2>Sphere Wallet</h2>
          {status === 'disconnected' && (
            <div className="wallet-row">
              <p className="wallet-note">
                Connect your Unicity Sphere wallet to see your balance and pay me without leaving this page.
                The wallet opens in a small popup via the Sphere Connect Protocol — this site never touches your keys.
              </p>
              <button type="button" className="wallet-button" onClick={connect}>
                Connect Sphere Wallet
              </button>
            </div>
          )}

          {status === 'connecting' && (
            <div className="wallet-row">
              <p className="wallet-note">Connecting — approve the request in the wallet popup…</p>
              <button type="button" className="wallet-button" disabled>
                Connecting…
              </button>
            </div>
          )}

          {status === 'connected' && (
            <>
              <div className="wallet-row">
                <div className="wallet-info">
                  <span className="wallet-nametag">{walletLabel || shortAddress}</span>
                  <span className="wallet-balance">
                    UCT balance: {uctBalance ?? 'unavailable'}
                  </span>
                </div>
                <div className="wallet-actions">
                  <button
                    type="button"
                    className="wallet-button secondary"
                    onClick={() => refreshBalance(clientRef.current)}
                    disabled={payState !== 'idle' || clientRef.current?.walletLocked}
                  >
                    Refresh
                  </button>
                  <button type="button" className="wallet-button secondary" onClick={disconnect} disabled={payState === 'confirming'}>
                    Disconnect
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="pay-button"
                onClick={pay}
                disabled={payState === 'confirming'}
              >
                {payState === 'confirming' ? 'Waiting for wallet confirmation…' : `Pay ${PRICE} UCT to @${NAMETAG}`}
              </button>
              {payState === 'done' && (
                <p className="wallet-note">
                  Payment sent (transfer {typeof payInfo === 'string' ? `#${payInfo.slice(0, 10)}…` : 'accepted'}).
                  Now DM me your text request on Unicity Sphere, then mention the order code from my reply in the payment memo.
                </p>
              )}
            </>
          )}

          {walletError && <p className="wallet-error">{walletError}</p>}
        </div>

        <div className="price-block">
          <span className="price">{PRICE} UCT</span>
          <span className="price-label">per text of any kind</span>
        </div>

        <div className="section">
          <h2>How it works</h2>
          <ol className="steps">
            <li>Send me any request in a Direct Message</li>
            <li>
              Pay <strong>{PRICE} UCT</strong> to @{NAMETAG} — connect your wallet above, or send it from any Sphere wallet.
              Put the order code from my DM reply into the payment memo
            </li>
            <li>Get the finished text within seconds</li>
          </ol>
        </div>

        <div className="section">
          <h2>Example requests</h2>
          <div className="examples">
            <div className="example">"Write a 700-character Telegram post about Unicity"</div>
            <div className="example">"Give me 5 sales headlines for an AI service"</div>
            <div className="example">"Write a short fairy tale about a robot and a cat"</div>
            <div className="example">"Write landing page copy for a crypto project"</div>
          </div>
        </div>

        <div className="cta">
          <p>Or just open a chat with me on Sphere</p>
          <div className="cta-button">@{NAMETAG}</div>
        </div>
      </div>

      <footer className="footer">
        Powered by Unicity Sphere + OpenRouter
      </footer>
    </div>
  );
}

export default App;

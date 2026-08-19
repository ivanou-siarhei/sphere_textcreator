import { useEffect, useRef, useState } from 'react';
import './App.scss';

const PRICE = Number(import.meta.env.VITE_PRICE) || 10;
const NAMETAG = import.meta.env.VITE_NAMETAG || 'textcreator';
const NETWORK = import.meta.env.VITE_NETWORK || 'testnet2';
const WALLET_URL = import.meta.env.VITE_WALLET_URL || 'https://sphere.unicity.network';

const SESSION_KEY = 'textcreator:connect-session';

// Matches MAX_INPUT_LEN in agent/index.js
const MAX_REQUEST_LEN = 4000;

// Verified facts from @unicitylabs/sphere-sdk v0.14.9 (dist/connect) and
// unicity-sphere/sphere-sdk-connect-example (browser/src/components):
// - Connect Protocol v2.1; only SPHERE_NETWORKS.testnet2 = { id: 4 } is exported.
// - UCT testnet2 coinId is lowercase 64-hex; the 'UCT' symbol itself is rejected by wallets.
// - Amounts are transferred as decimal strings in base units; UCT has 6 decimals.
// - Intent schemas: send → { to, amount, coinId, memo? }; dm → { to, message }.
const UCT_COIN_ID_TESTNET2 = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';
const PRICE_MICRO = BigInt(Math.round(PRICE * 1e6)).toString();

const WALLET_ERRORS = {
  4002: 'The wallet did not grant the required permission for this action.',
  4003: 'The request was rejected in the wallet.',
  4007: 'Unsupported wallet version. Open or update sphere.unicity.network and try again.',
  4008: 'Network mismatch: this page targets Unicity testnet2. Switch your wallet network.',
  4009: 'The wallet is locked. Unlock it and try again.',
  4100: 'Insufficient balance for this payment.',
  4200: 'The action was cancelled in the wallet.',
  4201: 'Outcome unknown. Check your wallet history before trying again — the transfer may already be in flight.',
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
  const [actionError, setActionError] = useState(null);
  const [payState, setPayState] = useState('idle');     // idle | confirming | done | error
  const [payInfo, setPayInfo] = useState(null);

  // Request form state
  const [requestText, setRequestText] = useState('');
  const [requestState, setRequestState] = useState('idle'); // idle | sending | sent
  const [orderCode, setOrderCode] = useState('');           // optional memo from the agent reply
  const pendingSubmit = useRef(false);
  const submitRef = useRef(null);

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
      setActionError(null);
      sessionStorage.removeItem(SESSION_KEY);
    });
    // wallet:locked — the session STAYS ALIVE; nothing to clean up.
    client.on(WALLET_EVENTS.LOCKED, () => {});
  };

  const performConnect = async (resumeSessionId, silent) => {
    const [connectSdk, connectBrowserSdk] = await loadSphereConnect();
    const { SPHERE_NETWORKS, PERMISSION_SCOPES } = connectSdk;
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
        PERMISSION_SCOPES.DM_REQUEST,
      ],
      timeout: 30000,
      intentTimeout: 120000,
      ...(resumeSessionId ? { resumeSessionId, silent: silent ?? true } : {}),
    });

    clientRef.current = result.client;
    sessionStorage.setItem(SESSION_KEY, result.connection.sessionId);
    attachEvents(result.client, connectSdk);
    setStatus('connected');
    setActionError(null);

    const ident = result.client.walletIdentity ?? result.connection.identity ?? null;
    setIdentity(ident);

    if (result.client.walletLocked) {
      setUctBalance(null); // balance query answers 4009 until the wallet is unlocked
    } else {
      await refreshBalance(result.client);
    }
  };

  const connect = async () => {
    setStatus('connecting');
    setActionError(null);
    try {
      await performConnect();
    } catch (err) {
      setStatus('disconnected');
      sessionStorage.removeItem(SESSION_KEY);
      setActionError(describeError(err));
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
    setActionError(null);
  };

  // ---------- Send the text request to the agent over Connect DM ----------
  const submitRequest = async () => {
    const client = clientRef.current;
    const text = requestText.trim();
    if (!client || !text || requestState === 'sending') return;
    setRequestState('sending');
    setActionError(null);
    try {
      const result = await client.intent('dm', { to: `@${NAMETAG}`, message: text });
      if (result && result.sent === false) throw new Error('Sending was rejected in the wallet.');
      setRequestState('sent');
    } catch (err) {
      setRequestState('idle');
      setActionError(describeError(err));
    }
  };
  submitRef.current = submitRequest;

  // If the user submitted the form while disconnected, connect first and then
  // deliver the request as soon as the session is up.
  useEffect(() => {
    if (status === 'connected' && pendingSubmit.current) {
      pendingSubmit.current = false;
      submitRef.current?.();
    }
  }, [status]);

  const connectAndSubmit = async () => {
    if (status === 'connected') return submitRequest();
    if (status !== 'disconnected') return; // already connecting
    if (!requestText.trim()) return;
    pendingSubmit.current = true;
    setStatus('connecting');
    setActionError(null);
    try {
      await performConnect();
    } catch (err) {
      pendingSubmit.current = false;
      setStatus('disconnected');
      sessionStorage.removeItem(SESSION_KEY);
      setActionError(describeError(err));
    }
  };

  // ---------- Pay the agent ----------
  const pay = async () => {
    const client = clientRef.current;
    if (!client || payState === 'confirming') return;
    setPayState('confirming');
    setPayInfo(null);
    setActionError(null);
    try {
      const params = {
        to: `@${NAMETAG}`,
        amount: PRICE_MICRO,
        coinId: UCT_COIN_ID_TESTNET2,
      };
      if (orderCode.trim()) params.memo = orderCode.trim();
      const result = await client.intent('send', params);
      setPayState('done');
      setPayInfo(result?.transferId ?? null);
      await refreshBalance(client);
    } catch (err) {
      setPayState('error');
      setActionError(describeError(err));
    }
  };

  const walletLabel = identity?.nametag ? `@${identity.nametag}` : null;
  const shortAddress = identity
    ? (identity.nametag ? null : `${identity.chainPubkey.slice(0, 8)}…${identity.chainPubkey.slice(-6)}`)
    : null;

  const requestBusy = status === 'connecting' || requestState === 'sending';
  const submitLabel =
    status === 'connected'
      ? (requestState === 'sending' ? 'Waiting for wallet confirmation…' : `Send to @${NAMETAG}`)
      : (status === 'connecting' ? 'Connecting…' : 'Connect wallet & send');

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
                Connect your Unicity Sphere wallet to send requests, check your balance and pay —
                all from this page. The wallet opens in a small popup via the Sphere Connect Protocol;
                this site never touches your keys.
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
          )}

          {actionError && <p className="wallet-error">{actionError}</p>}
        </div>

        <div className="section request">
          <h2>Send your request</h2>
          <p className="request-hint">
            Describe the text you need — topic, length, style. It is delivered straight to my Direct Message,
            where I generate the text and reply.
          </p>
          <textarea
            className="request-input"
            aria-label="Your text request"
            placeholder="Example: write a 700-character Telegram post about Unicity in a friendly tone"
            rows={5}
            maxLength={MAX_REQUEST_LEN}
            value={requestText}
            disabled={requestBusy}
            onChange={(e) => {
              setRequestText(e.target.value);
              if (requestState === 'sent') setRequestState('idle');
            }}
          />
          <div className="request-actions">
            <span className="char-count">{requestText.length}/{MAX_REQUEST_LEN}</span>
            <button
              type="button"
              className="wallet-button"
              onClick={status === 'connected' ? submitRequest : connectAndSubmit}
              disabled={!requestText.trim() || requestBusy}
            >
              {submitLabel}
            </button>
          </div>

          {requestState === 'sent' && (
            <p className="request-note">
              Request delivered to <strong>@{NAMETAG}</strong>. Check your Sphere DMs — my reply will carry the
              order code (TC-…) and an invoice for {PRICE} UCT. Put that code into the memo field below when paying.
            </p>
          )}

          {status === 'connected' && (
            <div className="request-pay">
              <label className="order-code-label" htmlFor="order-code">
                Order code from my reply — goes into the payment memo (optional)
              </label>
              <input
                id="order-code"
                className="order-code-input"
                type="text"
                placeholder="e.g. TC-9F2A1C"
                maxLength={12}
                autoComplete="off"
                spellCheck={false}
                value={orderCode}
                disabled={payState === 'confirming'}
                onChange={(e) => setOrderCode(e.target.value)}
              />
              <button
                type="button"
                className="pay-button"
                onClick={pay}
                disabled={payState === 'confirming'}
              >
                {payState === 'confirming' ? 'Waiting for wallet confirmation…' : `Pay ${PRICE} UCT to @${NAMETAG}`}
              </button>
              {payState === 'done' && (
                <p className="request-note">
                  Payment accepted (transfer {typeof payInfo === 'string' ? `#${payInfo.slice(0, 10)}…` : ''}).
                  {requestState === 'sent'
                    ? ' As soon as my reply with the order code arrives, generation starts automatically.'
                    : ' Now send your request above — I start writing once the order text is in my inbox.'}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="price-block">
          <span className="price">{PRICE} UCT</span>
          <span className="price-label">per text of any kind</span>
        </div>

        <div className="section">
          <h2>How it works</h2>
          <ol className="steps">
            <li>Describe your request in the field above and press Send — it lands in my Direct Message</li>
            <li>
              Pay <strong>{PRICE} UCT</strong> to @{NAMETAG} right on this page and put the order code from my
              reply into the memo field
            </li>
            <li>Get the finished text within seconds — as a DM reply in your Sphere wallet</li>
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

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Authenticator,
  View,
  Heading,
  Text,
  useAuthenticator,
} from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import './App.css';

import DetectionTool from './DetectionTool';
import ProjectsPage from './pages/ProjectsPage';
import { getUserTier, tierLabel, tierColor } from './services/userService';
import { useSessionGuard } from './hooks/useSessionGuard';
import MfaSetupModal from './components/MfaSetupModal';
import { isTotpEnabled } from './services/mfaService';

// ─── Trial panel ──────────────────────────────────────────────────────────────
// There is no plan to pick at sign-up: every new account gets the same 14-day
// Pro trial, granted server-side from the Cognito account-creation date. (The
// old picker wrote `custom:plan`, which the server trusted — audit finding C1.)
const TRIAL_DAYS = 14;
const TRIAL_FEATURES = [
  '5 projects',
  'AI takeoff agent — 3 sheets',
  'DXF export',
  'Custom classes',
  'All annotation tools',
  'Multi-page PDF',
];

function TrialPanel() {
  return (
    <View style={{ marginTop: 10, marginBottom: 2 }}>
      <div style={{
        padding: '12px 14px', borderRadius: 8,
        border: '2px solid #0f8fb3', background: 'rgba(15,143,179,0.1)',
      }}>
        <div style={{ fontWeight: 700, color: '#10b7e8', fontSize: 13, marginBottom: 2 }}>
          {TRIAL_DAYS}-day Pro trial
        </div>
        <div style={{ color: '#5a8aaa', fontSize: 10, marginBottom: 8 }}>
          Free for 14 days — no credit card
        </div>
        <ul style={{
          margin: 0, padding: '0 0 0 13px', color: '#6a9ab4', fontSize: 10,
          lineHeight: 1.75, columns: 2, columnGap: 14,
        }}>
          {TRIAL_FEATURES.map(f => <li key={f}>{f}</li>)}
        </ul>
        <div style={{ color: '#5a8aaa', fontSize: 9.5, marginTop: 8, lineHeight: 1.5 }}>
          After {TRIAL_DAYS} days your projects stay viewable and exportable until you upgrade.
        </div>
      </div>
    </View>
  );
}

// ─── Auth header — adapts text and shows plan cards on sign-up tab ────────────
// Support address for MFA lockouts. Cognito has no TOTP backup codes and no
// self-service reset, so an operator running admin-set-user-mfa-preference is the
// only way back in — see SECURITY-AUDIT.md H5.
const SUPPORT_EMAIL = 'thierry.elsayah@gmail.com';

function AuthHeader() {
  const { route } = useAuthenticator((ctx) => [ctx.route]);
  const isSignUp  = route === 'signUp';
  const isConfirm = route === 'confirmSignUp';
  // Shown while Cognito is asking for the 6-digit code, and while the
  // Authenticator is walking a user through its own TOTP setup screen.
  const isMfa     = route === 'confirmSignIn';
  const isTotp    = route === 'setupTotp';

  const heading = isSignUp ? 'Create an account'
    : isConfirm ? 'Verify your email'
    : isMfa ? 'Two-factor authentication'
    : isTotp ? 'Set up two-factor authentication'
    : 'Welcome back';
  const sub = isSignUp ? 'Start your free trial'
    : isConfirm ? 'Enter the code we sent to your email'
    : isMfa ? 'Enter the 6-digit code from your authenticator app'
    : isTotp ? 'Scan the code with your authenticator app'
    : 'Sign in to continue';

  return (
    <View style={{ paddingBottom: 14 }}>
      <div style={{ textAlign: 'center' }}>
        <Heading level={3} style={{ color: '#fff' }}>{heading}</Heading>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>{sub}</Text>
        {isMfa && (
          // Placed here because this is the screen a locked-out user is actually
          // staring at — a link anywhere else would never be found.
          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 10 }}>
            Lost your authenticator?{' '}
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Lost authenticator — two-factor reset request')}`}
              style={{ color: '#4fc3e8' }}
            >
              Contact support
            </a>
          </Text>
        )}
      </div>
      {isSignUp && <TrialPanel />}
    </View>
  );
}

// ─── Stable Authenticator config (defined once — never remounts) ──────────────
const authFormFields = {
  // `loginMechanisms={['email']}` above makes sign-up use the email address as
  // the Cognito username, so the separate Username field disappears. It would
  // also make this field type="email", which browser validation would use to
  // REJECT the pre-existing accounts whose usernames are not email addresses
  // (the pool has no email alias, and AliasAttributes cannot be added after
  // creation). Overriding the whole field back to type "text" keeps those
  // accounts able to sign in while new ones use their email.
  // TODO: drop this override once the legacy accounts are migrated — see
  // SECURITY-AUDIT.md H5 "Email-only sign-in".
  signIn: {
    username: {
      label: 'Email',
      placeholder: 'Enter your email',
      type: 'text',
      autocomplete: 'username',
      isRequired: true,
    },
  },
  signUp: {
    email:            { order: 1, label: 'Email',            placeholder: 'Enter your email' },
    name:             { order: 2, label: 'Full Name',        placeholder: 'Your full name' },
    password:         { order: 3, label: 'Password',         placeholder: 'Create a password' },
    confirm_password: { order: 4, label: 'Confirm Password', placeholder: 'Repeat your password' },
  },
};

const authComponents = { Header: AuthHeader };

// ─── Login screen ─────────────────────────────────────────────────────────────
function LoginScreen() {
  return (
    <div className="auth-page">
      <div className="auth-left">
        <div className="auth-overlay">
          <div className="auth-copy">
            <h1>SiteSeeing Quant</h1>
            <p>Reliable AI-powered quantity takeoff for construction drawings and plans.</p>
          </div>
        </div>
      </div>
      <div className="auth-right">
        <div className="auth-card">
          <Authenticator
          loginMechanisms={['email']}
          formFields={authFormFields}
          components={authComponents}
        />
        </div>
      </div>
    </div>
  );
}

// ─── Forced sign-out modal ────────────────────────────────────────────────────
// Shown after another device claims this account's session and our heartbeat
// caught the change. Renders only when the user is already signed out so it
// sits on top of <LoginScreen />.
function ForcedSignOutModal({ onDismiss }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#0f1a2c', border: '1px solid rgba(100,150,255,0.25)',
        borderRadius: 10, padding: '24px 28px', maxWidth: 420,
        boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        color: '#dbe7ff', fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 10, color: '#10b7e8' }}>
          You&apos;ve been signed out
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 18 }}>
          This account was opened on another device. Only one active session is
          allowed at a time.
        </div>
        <button
          onClick={onDismiss}
          style={{
            background: '#0f8fb3', color: '#fff', border: 'none',
            borderRadius: 6, padding: '8px 16px', fontWeight: 600,
            cursor: 'pointer', fontSize: 13,
          }}
        >
          Sign back in
        </button>
      </div>
    </div>
  );
}

// ─── Main app (authenticated) ─────────────────────────────────────────────────
function MainApp() {
  const { user, signOut } = useAuthenticator((context) => [context.user, context.signOut]);
  const { forcedOut, dismiss } = useSessionGuard(user, signOut);

  const [currentPage, setCurrentPage] = useState('projects');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMfa, setShowMfa] = useState(false);
  const [mfaNudge, setMfaNudge] = useState(false);
  const menuRef = useRef(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [userTierInfo, setUserTierInfo] = useState({ tier: 'trial', role: null });

  const prevUserRef = useRef(user);
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;
    if (!prev && user) {
      setCurrentPage('projects');
      setSelectedProject(null);
      setRefreshKey((k) => k + 1);
      getUserTier().then(setUserTierInfo).catch(() => {});
    }
  }, [user]);

  useEffect(() => {
    if (user) getUserTier().then(setUserTierInfo).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-time nudge to enable 2FA. TOTP cannot be offered during sign-up — it
  // needs an authenticated session to associate the secret with — so the first
  // opportunity to ask is here, after sign-in. Dismissal is remembered per user
  // so it asks once rather than nagging.
  useEffect(() => {
    if (!user) return;
    const key = `mfaNudgeDismissed:${user.userId || user.username}`;
    let dismissed = false;
    try { dismissed = localStorage.getItem(key) === '1'; } catch { /* private mode */ }
    if (dismissed) return;
    let alive = true;
    // Failure here must stay silent: a nudge is not worth an error, and showing
    // it to someone who already has 2FA on would be worse than not showing it.
    isTotpEnabled().then((on) => { if (alive && !on) setMfaNudge(true); }).catch(() => {});
    // eslint-disable-next-line consistent-return
    return () => { alive = false; };
  }, [user]);

  const dismissMfaNudge = useCallback(() => {
    setMfaNudge(false);
    try { localStorage.setItem(`mfaNudgeDismissed:${user?.userId || user?.username}`, '1'); } catch { /* private mode */ }
  }, [user]);

  // Dismiss the account menu on an outside click or Escape, as a menu should
  // behave; without this it stays open behind the modal.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey  = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  if (!user) {
    return (
      <>
        <LoginScreen />
        {forcedOut && <ForcedSignOutModal onDismiss={dismiss} />}
      </>
    );
  }

  const handleOpenProject  = (project) => { setSelectedProject(project); setCurrentPage('editor'); };
  const handleBackToProjects = () => { setCurrentPage('projects'); setRefreshKey((k) => k + 1); };

  return (
    // Viewport-height flex column so the editor fills exactly the space left
    // below the top bar. Without this the editor's own 100vh pushed its status
    // bar (Run analysis, zone totals) below the fold.
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div className="top-bar" style={{ flexShrink: 0 }}>
        <span className="username">
          {currentPage === 'editor' && selectedProject?.name ? selectedProject.name : user?.username}
        </span>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* The tier pill doubles as the account menu. It sits outside the
              currentPage switch, so Security is reachable from both views. */}
          <div className="acct-menu" ref={menuRef}>
            <button
              className="acct-pill"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              style={{
                color: tierColor(userTierInfo.tier, userTierInfo.role),
                borderColor: tierColor(userTierInfo.tier, userTierInfo.role),
              }}
            >
              {tierLabel(userTierInfo.tier, userTierInfo.role, userTierInfo.trial)}
              <span className="acct-caret">▾</span>
            </button>
            {menuOpen && (
              <div className="acct-dropdown" role="menu">
                <div className="acct-email">{user?.signInDetails?.loginId || user?.username}</div>
                <button
                  className="acct-item"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); setShowMfa(true); }}
                >
                  Two-factor authentication
                </button>
              </div>
            )}
          </div>
          {currentPage === 'editor' && (
            <button className="signout-btn" onClick={handleBackToProjects}>Back to Projects</button>
          )}
          <button className="signout-btn" onClick={signOut}>Sign out</button>
        </div>
      </div>

      {mfaNudge && !showMfa && (
        <div className="mfa-nudge">
          <span className="mfa-nudge-text">
            Add two-factor authentication to protect your account with more than a password.
          </span>
          <button
            className="mfa-nudge-cta"
            onClick={() => { setMfaNudge(false); setShowMfa(true); }}
          >
            Set up
          </button>
          <button className="mfa-nudge-later" onClick={dismissMfaNudge}>Later</button>
        </div>
      )}

      {showMfa && (
        <MfaSetupModal
          accountLabel={user?.signInDetails?.loginId || user?.username}
          onClose={() => setShowMfa(false)}
        />
      )}

      {currentPage === 'projects' ? (
        // Projects list scrolls on its own; the editor manages its internal
        // scrolling, so it just fills the remaining height.
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ProjectsPage
            onOpenProject={handleOpenProject}
            user={user}
            refreshKey={refreshKey}
            userTierInfo={userTierInfo}
          />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <DetectionTool
            project={selectedProject}
            user={user}
            onBack={handleBackToProjects}
            userTierInfo={userTierInfo}
          />
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Authenticator.Provider>
      <MainApp />
    </Authenticator.Provider>
  );
}

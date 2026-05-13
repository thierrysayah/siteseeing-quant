import { useState, useEffect, useRef } from 'react';
import {
  Authenticator,
  View,
  Heading,
  Text,
  useAuthenticator,
} from '@aws-amplify/ui-react';
import { signUp } from 'aws-amplify/auth';
import '@aws-amplify/ui-react/styles.css';
import './App.css';

import DetectionTool from './DetectionTool';
import ProjectsPage from './pages/ProjectsPage';
import { getUserTier, tierLabel, tierColor } from './services/userService';
import { useSessionGuard } from './hooks/useSessionGuard';

// ─── Module-level plan selection ──────────────────────────────────────────────
// Stored outside React state so authComponents / authServices stay stable
// (never remount the Authenticator when user toggles between plans).
const _planSel = { current: 'individual' };

// ─── Plan card ────────────────────────────────────────────────────────────────
const PLANS = {
  individual: {
    label: 'Individual',
    price: 'Free',
    features: ['2 projects', 'All annotation tools', 'AI inference', 'Multi-page PDF'],
  },
  pro: {
    label: 'Pro',
    price: 'Billing coming soon',
    features: ['10 projects', 'DXF export', 'Custom classes', 'Priority support'],
  },
};

function PlanCard({ plan, selected, onSelect }) {
  const { label, price, features } = PLANS[plan];
  return (
    <div
      onClick={onSelect}
      style={{
        flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
        border: selected ? '2px solid #0f8fb3' : '2px solid rgba(100,150,255,0.2)',
        background: selected ? 'rgba(15,143,179,0.1)' : 'rgba(255,255,255,0.02)',
        transition: 'border-color 0.15s, background 0.15s',
        userSelect: 'none',
      }}
    >
      <div style={{ fontWeight: 700, color: selected ? '#10b7e8' : '#8ab4d4', fontSize: 13, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ color: '#5a8aaa', fontSize: 10, marginBottom: 6 }}>{price}</div>
      <ul style={{ margin: 0, padding: '0 0 0 13px', color: '#6a9ab4', fontSize: 10, lineHeight: 1.75 }}>
        {features.map(f => <li key={f}>{f}</li>)}
      </ul>
    </div>
  );
}

// PlanCards manages its own display state but writes to the module-level ref
function PlanCards() {
  const [sel, setSel] = useState(_planSel.current);
  return (
    <View style={{ marginTop: 10, marginBottom: 2 }}>
      <div style={{ color: 'rgba(235,243,255,0.75)', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
        Choose your plan
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {Object.keys(PLANS).map(plan => (
          <PlanCard
            key={plan}
            plan={plan}
            selected={sel === plan}
            onSelect={() => { _planSel.current = plan; setSel(plan); }}
          />
        ))}
      </div>
    </View>
  );
}

// ─── Auth header — adapts text and shows plan cards on sign-up tab ────────────
function AuthHeader() {
  const { route } = useAuthenticator((ctx) => [ctx.route]);
  const isSignUp   = route === 'signUp';
  const isConfirm  = route === 'confirmSignUp';
  return (
    <View style={{ paddingBottom: 14 }}>
      <div style={{ textAlign: 'center' }}>
        <Heading level={3} style={{ color: '#fff' }}>
          {isSignUp ? 'Create an account' : isConfirm ? 'Verify your email' : 'Welcome back'}
        </Heading>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>
          {isSignUp
            ? 'Start your free trial — no credit card required'
            : isConfirm
            ? 'Enter the code we sent to your email'
            : 'Sign in to continue'}
        </Text>
      </div>
      {isSignUp && <PlanCards />}
    </View>
  );
}

// ─── Stable Authenticator config (defined once — never remounts) ──────────────
const authFormFields = {
  signUp: {
    email:            { order: 1, label: 'Email',            placeholder: 'Enter your email' },
    name:             { order: 2, label: 'Full Name',        placeholder: 'Your full name' },
    password:         { order: 3, label: 'Password',         placeholder: 'Create a password' },
    confirm_password: { order: 4, label: 'Confirm Password', placeholder: 'Repeat your password' },
  },
};

const authComponents = { Header: AuthHeader };

// Injects custom:plan into every sign-up request
const authServices = {
  async handleSignUp(input) {
    return signUp({
      ...input,
      options: {
        ...input.options,
        userAttributes: {
          ...input.options?.userAttributes,
          'custom:plan': _planSel.current,
        },
      },
    });
  },
};

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
            formFields={authFormFields}
            services={authServices}
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
  const [selectedProject, setSelectedProject] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [userTierInfo, setUserTierInfo] = useState({ tier: 'individual', role: null });

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
    <div>
      <div className="top-bar">
        <span className="username">
          {currentPage === 'editor' && selectedProject?.name ? selectedProject.name : user?.username}
        </span>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <span style={{
            fontFamily: 'monospace', fontSize: 10, fontWeight: 700, letterSpacing: '1.5px',
            textTransform: 'uppercase',
            color: tierColor(userTierInfo.tier, userTierInfo.role),
            border: `1px solid ${tierColor(userTierInfo.tier, userTierInfo.role)}`,
            borderRadius: 4, padding: '2px 8px', opacity: 0.85,
          }}>
            {tierLabel(userTierInfo.tier, userTierInfo.role)}
          </span>
          {currentPage === 'editor' && (
            <button className="signout-btn" onClick={handleBackToProjects}>Back to Projects</button>
          )}
          <button className="signout-btn" onClick={signOut}>Sign out</button>
        </div>
      </div>

      {currentPage === 'projects' ? (
        <ProjectsPage
          onOpenProject={handleOpenProject}
          user={user}
          refreshKey={refreshKey}
          userTierInfo={userTierInfo}
        />
      ) : (
        <DetectionTool
          project={selectedProject}
          user={user}
          onBack={handleBackToProjects}
          userTierInfo={userTierInfo}
        />
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

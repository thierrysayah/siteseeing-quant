import DetectionTool from './DetectionTool';
import {
  Authenticator,
  View,
  Heading,
  Text,
  useAuthenticator,
} from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import './App.css';

function LoginScreen() {
  return (
    <div className="auth-page">
      <div className="auth-left">
        <div className="auth-overlay">
          <div className="auth-copy">
            <h1>SiteSeeing Quant</h1>
            <p>
              Reliable AI-powered quantity takeoff for construction drawings and plans.
            </p>
          </div>
        </div>
      </div>

      <div className="auth-right">
        <div className="auth-card">
          <Authenticator
            hideSignUp
            components={{
              Header() {
                return (
                  <View style={{ textAlign: 'center', paddingBottom: '14px' }}>
                    <Heading level={3}>Welcome</Heading>
                    <Text>Sign in to continue</Text>
                  </View>
                );
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}

function MainApp() {
  const { user, signOut } = useAuthenticator((context) => [
    context.user,
    context.signOut,
  ]);

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div>
      <div className="top-bar">
          <span className="username">{user?.username}</span>
          <button className="signout-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      <DetectionTool />
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
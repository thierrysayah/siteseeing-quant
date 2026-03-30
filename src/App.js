import { useState, useEffect, useRef } from 'react';
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

  const [currentPage, setCurrentPage] = useState('projects');
  const [selectedProject, setSelectedProject] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Reset to projects page whenever a new sign-in happens (user transitions
  // from null → non-null), so the editor never persists across sessions.
  const prevUserRef = useRef(user);
  useEffect(() => {
    const prev = prevUserRef.current;
    prevUserRef.current = user;
    if (!prev && user) {
      setCurrentPage('projects');
      setSelectedProject(null);
      setRefreshKey((k) => k + 1);
    }
  }, [user]);

  if (!user) {
    return <LoginScreen />;
  }

  const handleOpenProject = (project) => {
    setSelectedProject(project);
    setCurrentPage('editor');
  };

  const handleBackToProjects = () => {
    setCurrentPage('projects');
    setRefreshKey((k) => k + 1);
  };

  return (
    <div>
      <div className="top-bar">
        <span className="username">
          {currentPage === 'editor' && selectedProject?.name
            ? selectedProject.name
            : user?.username}
        </span>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {currentPage === 'editor' && (
            <button className="signout-btn" onClick={handleBackToProjects}>
              Back to Projects
            </button>
          )}

          <button className="signout-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {currentPage === 'projects' ? (
        <ProjectsPage
          onOpenProject={handleOpenProject}
          user={user}
          refreshKey={refreshKey}
        />
      ) : (
        <DetectionTool
          project={selectedProject}
          user={user}
          onBack={handleBackToProjects}
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

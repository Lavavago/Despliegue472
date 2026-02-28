import React, { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import Navbar from './components/Navbar';
import DatabaseView from './components/DatabaseView';
import ProcessorView from './components/ProcessorView';
import MapView from './components/MapView';
import Login from './components/Login';
import { AuthSession } from './types';
import { supabase, clearGeoCache, ensureMunicipalIndexWarmCache, getMunicipalIndexStats, ensureZonesWarmCache } from './services/postalService';
import TeamManager from './components/TeamManager';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'database' | 'processor' | 'map'>(() => {
    try {
      const raw = localStorage.getItem('activeTab');
      if (raw === 'processor' || raw === 'map' || raw === 'database') return raw as any;
    } catch {}
    return 'database';
  });
  const disableAuth = ((import.meta as any).env.VITE_DISABLE_AUTH === '1');
  const [auth, setAuth] = useState<AuthSession | null>(() => {
    if (disableAuth) {
      return { email: 'dev@local', role: 'TI' };
    }
    try {
      const raw = localStorage.getItem('auth');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState<string | null>(null);
  const [showOldPwd, setShowOldPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [showTeamManager, setShowTeamManager] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reset = params.get('reset');
    if (reset === '1') {
      try { localStorage.removeItem('processorState'); } catch {}
      clearGeoCache().catch(() => {});
    }
    (async () => {
      try {
        const stats = await getMunicipalIndexStats();
        if (stats.count > 0) {
          await ensureMunicipalIndexWarmCache();
        }
        await ensureZonesWarmCache();
      } catch {}
    })();
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {!auth ? (
        <Login onSuccess={(a: AuthSession) => { localStorage.setItem('auth', JSON.stringify(a)); setAuth(a); }} />
      ) : (
        <>
          <Navbar 
            activeTab={activeTab} 
            onTabChange={(t) => { setActiveTab(t); try { localStorage.setItem('activeTab', t); } catch {} }} 
            onLogout={() => { localStorage.removeItem('auth'); setAuth(null); }} 
            onChangePassword={() => { setPwdError(null); setPwdSuccess(null); setOldPwd(''); setNewPwd(''); setConfirmPwd(''); setShowChangePwd(true); }}
            isAdmin={auth.role === 'Admin'}
            onOpenTeam={() => setShowTeamManager(true)}
          />
          <main className="py-6 px-4 sm:px-6 lg:px-8 h-full">
            {activeTab === 'database' && <DatabaseView />}
            {activeTab === 'processor' && <ProcessorView />}
            {activeTab === 'map' && <MapView />}
          </main>
          {showChangePwd && auth && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[1000]">
              <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-md p-6">
                <h2 className="text-lg font-bold text-slate-800">Cambiar Contraseña</h2>
                <p className="text-xs text-slate-500 mt-1">Usuario: {auth.email}</p>
                <div className="mt-4 space-y-3">
                  <div className="relative">
                    <input
                      type={showOldPwd ? 'text' : 'password'}
                      value={oldPwd}
                      onChange={(e) => setOldPwd(e.target.value)}
                      placeholder="Contraseña anterior"
                      autoComplete="off"
                      name="old-password"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="block w-full px-3 pr-10 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowOldPwd((s) => !s)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                      aria-label={showOldPwd ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    >
                      {showOldPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type={showNewPwd ? 'text' : 'password'}
                      value={newPwd}
                      onChange={(e) => setNewPwd(e.target.value)}
                      placeholder="Nueva contraseña"
                      autoComplete="new-password"
                      name="new-password"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="block w-full px-3 pr-10 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPwd((s) => !s)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                      aria-label={showNewPwd ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    >
                      {showNewPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type={showConfirmPwd ? 'text' : 'password'}
                      value={confirmPwd}
                      onChange={(e) => setConfirmPwd(e.target.value)}
                      placeholder="Confirmar nueva contraseña"
                      autoComplete="new-password"
                      name="confirm-password"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="block w-full px-3 pr-10 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPwd((s) => !s)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                      aria-label={showConfirmPwd ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    >
                      {showConfirmPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {pwdError && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2">{pwdError}</div>
                  )}
                  {pwdSuccess && (
                    <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{pwdSuccess}</div>
                  )}
                </div>
                <div className="mt-4 flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowChangePwd(false)}
                    className="px-3 py-2 text-sm rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setPwdError(null);
                      setPwdSuccess(null);
                      if (!oldPwd || !newPwd || !confirmPwd) {
                        setPwdError('Completa todos los campos.');
                        return;
                      }
                      if (newPwd !== confirmPwd) {
                        setPwdError('La confirmación no coincide.');
                        return;
                      }
                      const { data, error } = await supabase
                        .from('profiles')
                        .select('email, password_plain')
                        .eq('email', auth.email.toLowerCase())
                        .single();
                      if (error || !data) {
                        setPwdError('Usuario no encontrado.');
                        return;
                      }
                      if (data.password_plain !== oldPwd) {
                        setPwdError('La contraseña anterior no coincide.');
                        return;
                      }
                      const { error: updErr } = await supabase
                        .from('profiles')
                        .update({ password_plain: newPwd })
                        .eq('email', auth.email.toLowerCase());
                      if (updErr) {
                        setPwdError('No se pudo actualizar la contraseña.');
                        return;
                      }
                      setPwdSuccess('Contraseña actualizada correctamente.');
                    }}
                    className="px-3 py-2 text-sm rounded-md bg-brand-600 text-white hover:bg-brand-700"
                  >
                    Guardar
                  </button>
                </div>
              </div>
            </div>
          )}
          {activeTab !== 'map' && (
            <footer className="bg-white border-t border-slate-200 mt-auto py-6">
              <div className="max-w-7xl mx-auto px-4 text-center text-slate-500 text-sm">
                <p>© {new Date().getFullYear()} Sistema de Gestión Postal Colombia.</p>
                <p className="mt-1 text-xs text-slate-400">Desarrollado para validación de cobertura 472.</p>
              </div>
            </footer>
          )}
          {showTeamManager && auth?.role === 'Admin' && (
            <TeamManager onClose={() => setShowTeamManager(false)} />
          )}
        </>
      )}
    </div>
  );
};

export default App;

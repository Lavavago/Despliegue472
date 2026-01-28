import React, { useState } from 'react';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { UserRole, AuthSession } from '../types';
import { supabase } from '../services/postalService';

interface LoginProps {
  onSuccess: (auth: AuthSession) => void;
}

const ROLE_EMAILS: Record<UserRole, string> = {
  TI: 'ti@colpostal472.com',
  Contabilidad: 'contabilidad@colpostal472.com',
  Facturación: 'facturacion@colpostal472.com',
  Operaciones: 'operaciones@colpostal472.com',
};


const Login: React.FC<LoginProps> = ({ onSuccess }) => {
  const [role, setRole] = useState<UserRole>('TI');
  const [email, setEmail] = useState<string>(ROLE_EMAILS['TI']);
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  };

  const selectRole = (r: UserRole) => {
    setRole(r);
    setEmail(ROLE_EMAILS[r]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const userEmail = email.trim().toLowerCase();
    const { data, error: fetchError } = await supabase
      .from('profiles')
      .select('email')
      .eq('email', userEmail)
      .eq('password_plain', password)
      .single();

    if (fetchError || !data) {
      setError('Credenciales inválidas. Verifica correo y contraseña.');
      return;
    }

    onSuccess({ email: userEmail, role });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 w-full max-w-md p-6">
        
        <div className="flex flex-col items-center mb-4">
          <div className="text-blue-600 mb-1" aria-hidden>
            <svg width="120" height="40" viewBox="0 0 120 40" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="18" width="20" height="4" rx="2" fill="#2563eb" />
              <rect x="98" y="18" width="20" height="4" rx="2" fill="#2563eb" />
              <text x="60" y="26" textAnchor="middle" fontFamily="Inter, system-ui" fontWeight="800" fontSize="24" fill="#2563eb">472</text>
            </svg>
          </div>
          <p className="text-xs font-bold text-blue-600 tracking-wider uppercase">ColPostal</p>
          <p className="text-sm text-slate-500 mt-2">Ingresa tus credenciales de acceso</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Mail className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Correo corporativo"
              className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 placeholder:text-slate-400"
              required
            />
          </div>

          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Lock className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña"
              className="block w-full pl-10 pr-10 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 placeholder:text-slate-400"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
              aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-2">
            {(['TI', 'Contabilidad', 'Facturación', 'Operaciones'] as UserRole[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => selectRole(r)}
                className={`px-3 py-2 rounded-md text-sm font-medium border transition-all ${
                  role === r
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>
          )}

          <button
            type="submit"
            className="w-full bg-blue-600 text-white rounded-md py-2 text-sm font-bold hover:bg-blue-700 transition-colors"
          >
            INICIAR SESIÓN
          </button>
        </form>

        <div className="text-center mt-3 text-xs text-slate-400">Configuración de seguridad / Cambiar clave</div>
      </div>
    </div>
  );
};

export default Login;
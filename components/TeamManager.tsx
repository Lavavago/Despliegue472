import React, { useEffect, useMemo, useState } from 'react';
import { X, Users, Plus, Pencil, Trash2, Save } from 'lucide-react';
import { supabase } from '../services/postalService';
import { UserRole } from '../types';

interface TeamManagerProps {
  onClose: () => void;
}

type ProfileRow = {
  id: string;
  email: string;
  password_plain: string;
  full_name: string;
  rol: string;
};

const AREAS: UserRole[] = ['TI', 'Contabilidad', 'Facturación', 'Operaciones'];

const TeamManager: React.FC<TeamManagerProps> = ({ onClose }) => {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [area, setArea] = useState<UserRole>('TI');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editArea, setEditArea] = useState<UserRole>('TI');
  const isValidNew = useMemo(() => email.trim() && password.trim(), [email, password]);

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, email, password_plain, full_name, rol')
      .order('email', { ascending: true });
    if (err) {
      setError('No se pudo cargar usuarios.');
    } else {
      setRows((data as any) || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setArea('TI');
  };

  const addUser = async () => {
    if (!isValidNew) return;
    setError(null);
    setSuccess(null);
    const payload = {
      email: email.trim().toLowerCase(),
      password_plain: password.trim(),
      full_name: area,
      rol: 'usuario'
    };
    const { error: err } = await supabase.from('profiles').insert(payload);
    if (err) {
      setError('No se pudo crear el usuario.');
      return;
    }
    setSuccess('Usuario creado.');
    resetForm();
    await load();
  };

  const startEdit = (r: ProfileRow) => {
    setEditingId(r.id);
    setEditEmail(r.email);
    setEditPassword(r.password_plain || '');
    const areaValue = (AREAS.includes(r.full_name as UserRole) ? (r.full_name as UserRole) : 'TI');
    setEditArea(areaValue);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditEmail('');
    setEditPassword('');
    setEditArea('TI');
  };

  const saveEdit = async (id: string) => {
    setError(null);
    setSuccess(null);
    const current = rows.find((x) => x.id === id);
    if (current && String(current.rol || '').toLowerCase().trim() === 'admin') {
      setError('El administrador no se puede editar.');
      return;
    }
    const payload: Partial<ProfileRow> = {
      email: editEmail.trim().toLowerCase(),
      password_plain: editPassword.trim(),
      full_name: editArea
    };
    const { error: err } = await supabase.from('profiles').update(payload).eq('id', id);
    if (err) {
      setError('No se pudo actualizar.');
      return;
    }
    setSuccess('Usuario actualizado.');
    cancelEdit();
    await load();
  };

  const removeUser = async (id: string) => {
    setError(null);
    setSuccess(null);
    const current = rows.find((x) => x.id === id);
    if (current && String(current.rol || '').toLowerCase().trim() === 'admin') {
      setError('El administrador no se puede eliminar.');
      return;
    }
    const { error: err } = await supabase.from('profiles').delete().eq('id', id);
    if (err) {
      setError('No se pudo eliminar.');
      return;
    }
    setSuccess('Usuario eliminado.');
    await load();
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-[1000]">
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-3xl">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Users className="h-5 w-5 text-slate-700" />
            <h2 className="text-lg font-bold text-slate-800">Gestionar Equipo</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-md hover:bg-slate-100">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Correo"
              className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
            />
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña"
              className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
            />
            <select
              value={area}
              onChange={(e) => setArea(e.target.value as UserRole)}
              className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
            >
              {AREAS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <button
              onClick={addUser}
              disabled={!isValidNew || loading}
              className="inline-flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              <Plus className="mr-1 h-4 w-4" />
              Agregar
            </button>
          </div>
          {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
          {success && <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md p-2">{success}</div>}
          <div className="border border-slate-200 rounded-lg">
            <div className="max-h-[60vh] overflow-y-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Correo</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Contraseña</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-500">Área</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-slate-500">Acciones</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2">
                      {editingId === r.id ? (
                        <input
                          type="email"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
                        />
                      ) : (
                        <span className="text-slate-800">{r.email}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingId === r.id ? (
                        <input
                          type="text"
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
                        />
                      ) : (
                        <span className="text-slate-800">{r.password_plain}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingId === r.id ? (
                        <select
                          value={editArea}
                          onChange={(e) => setEditArea(e.target.value as UserRole)}
                          className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
                        >
                          {AREAS.map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-slate-800">{r.full_name}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingId === r.id ? (
                        <div className="flex justify-end space-x-2">
                          <button onClick={() => saveEdit(r.id)} className="px-2 py-1 rounded-md bg-green-600 text-white text-xs hover:bg-green-700 inline-flex items-center">
                            <Save className="mr-1 h-3 w-3" />
                            Guardar
                          </button>
                          <button onClick={cancelEdit} className="px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs hover:bg-slate-200">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end space-x-2">
                          {String(r.rol || '').toLowerCase().trim() === 'admin' ? (
                            <>
                              <span className="px-2 py-1 rounded-md bg-yellow-100 text-yellow-800 text-xs">Admin</span>
                            </>
                          ) : (
                            <>
                              <button onClick={() => startEdit(r)} className="px-2 py-1 rounded-md bg-slate-100 text-slate-700 text-xs hover:bg-slate-200 inline-flex items-center">
                                <Pencil className="mr-1 h-3 w-3" />
                                Editar
                              </button>
                              <button onClick={() => removeUser(r.id)} className="px-2 py-1 rounded-md bg-red-600 text-white text-xs hover:bg-red-700 inline-flex items-center">
                                <Trash2 className="mr-1 h-3 w-3" />
                                Eliminar
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-400 text-xs" colSpan={4}>
                      Sin usuarios
                    </td>
                  </tr>
                )}
              </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TeamManager;

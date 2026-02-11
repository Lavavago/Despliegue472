import React from 'react';
import gleRojo from '../pages/gleRojo.jpeg';
import { Database, FileSpreadsheet, MapPin, Map as MapIcon, ArrowLeft } from 'lucide-react';

interface NavbarProps {
  activeTab: 'database' | 'processor' | 'map';
  onTabChange: (tab: 'database' | 'processor' | 'map') => void;
  onLogout?: () => void;
  onChangePassword?: () => void;
}

const Navbar: React.FC<NavbarProps> = ({ activeTab, onTabChange, onLogout, onChangePassword }) => {
  return (
    <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-28">
          <div className="flex items-center space-x-3">
            <img src={gleRojo} alt="Logo" className="h-36 w-36 object-contain" />
            <div>
              <h1 className="font-bold text-xl text-slate-800 tracking-tight leading-none">ColPostal 472</h1>
              <p className="text-[10px] text-slate-500 font-medium">Gestor de Códigos Postales</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <button
              onClick={onLogout}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100"
            >
              <ArrowLeft className="mr-1 h-4 w-4" />
              Devolver
            </button>
            <button
              onClick={onChangePassword}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100"
            >
              Cambiar Clave
            </button>
            <div className="flex space-x-1 bg-slate-50 p-1 rounded-lg border border-slate-200">
              <button
                onClick={() => onTabChange('database')}
                className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  activeTab === 'database' 
                    ? 'bg-white text-brand-700 shadow-sm border border-slate-200' 
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'
                }`}
              >
                <Database className="mr-2 h-4 w-4" />
                Base Maestra
              </button>
              <button
                onClick={() => onTabChange('processor')}
                className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  activeTab === 'processor' 
                    ? 'bg-white text-brand-700 shadow-sm border border-slate-200' 
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'
                }`}
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Reporteador
              </button>
              <button
                onClick={() => onTabChange('map')}
                className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  activeTab === 'map' 
                    ? 'bg-white text-brand-700 shadow-sm border border-slate-200' 
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'
                }`}
              >
                <MapIcon className="mr-2 h-4 w-4" />
                Mapa
              </button>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
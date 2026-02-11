import React, { useState, useEffect } from 'react';
import { Database, RefreshCw, Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FileArchive, ExternalLink, Info, FileSpreadsheet, Upload } from 'lucide-react';
import * as XLSX from 'xlsx';
import shp from 'shpjs';
import { saveShapefileData, getPostalDatabaseStats, getPaginatedPostalDatabase, updateZonesFromMasterExcel, syncZonesToSupabase, getMunicipalIndexStats, clearMunicipalIndex } from '../services/postalService';
import { PostalZone, PaginatedResult } from '../types';


const DatabaseView: React.FC = () => {
  const [stats, setStats] = useState({ count: 0, lastUpdated: null as Date | null });
  const [muniIndexCount, setMuniIndexCount] = useState(0);
  const [result, setResult] = useState<PaginatedResult<PostalZone>>({ data: [], total: 0, page: 1, totalPages: 0 });
  
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [itemsPerPage, setItemsPerPage] = useState(50);
  const [page, setPage] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMessage, setProcessingMessage] = useState('');

  useEffect(() => {
    loadStats();
    loadTable();
    loadMuniIndexStats();
  }, []);

  useEffect(() => { setPage(1); loadTable(); }, [searchQuery, itemsPerPage]);
  useEffect(() => { loadTable(); }, [page]);

  const loadStats = async () => {
      const s = await getPostalDatabaseStats();
      setStats(s);
  };

  const loadMuniIndexStats = async () => {
      try {
        const s = await getMunicipalIndexStats();
        setMuniIndexCount(s.count);
      } catch {}
  };

  const loadTable = async () => {
      const r = await getPaginatedPostalDatabase(page, itemsPerPage, searchQuery);
      setResult(r);
  };

  const handleShapefileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
        setMessage({ type: 'error', text: 'Por favor suba un archivo .zip que contenga el Shapefile (.shp, .dbf, .shx).' });
        return;
    }

    setLoading(true);
    setProgress(0);
    setProgressMsg('Leyendo archivo Shapefile...');
    setMessage(null);

    try {
        const arrayBuffer = await file.arrayBuffer();
        
        setProgress(20);
        setProgressMsg('Parseando geometría...');
        
        const geoJson = await shp(arrayBuffer);
        const validGeoJson = Array.isArray(geoJson) ? geoJson[0] : geoJson;
        
        if (!validGeoJson || !validGeoJson.features) {
            throw new Error("No se encontraron geometrías válidas en el archivo.");
        }

        await saveShapefileData(validGeoJson, (pct, msg) => {
            setProgress(pct);
            setProgressMsg(msg);
        });

        const syncRes = await syncZonesToSupabase(validGeoJson, (pct, msg) => {
            setProgress(pct);
            setProgressMsg(msg);
        });

        await loadStats();
        setSearchQuery('');
        setPage(1);
        await loadTable();
        const supabaseNote = syncRes.inserted > 0 ? ` Sincronizadas en Supabase: ${syncRes.inserted}.` : '';
        setMessage({ type: 'success', text: `Shapefile cargado exitosamente. ${validGeoJson.features.length} zonas importadas.${supabaseNote}` });

    } catch (err: any) {
        console.error(err);
        setMessage({ type: 'error', text: err.message || 'Error al procesar el archivo Shapefile' });
    } finally {
        setLoading(false);
        setProgress(0);
        setProgressMsg('');
    }
  };

  const handleMasterExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setLoading(true);
      setProgress(0);
      setProgressMsg('Leyendo Maestro Excel...');
      setMessage(null);

      try {
          const buffer = await file.arrayBuffer();
          const wb = XLSX.read(buffer, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(ws);
          
          if (jsonData.length === 0) throw new Error("El archivo Excel está vacío.");

          setProgress(30);
          setProgressMsg('Actualizando base de datos...');

          const { updated, total } = await updateZonesFromMasterExcel(jsonData);

          await loadTable();
          setMessage({ type: 'success', text: `Base actualizada con Maestro Excel. ${updated} zonas enriquecidas con nombres.` });

      } catch (err: any) {
          console.error(err);
          setMessage({ type: 'error', text: err.message || 'Error al procesar el Excel Maestro' });
      } finally {
          setLoading(false);
          setProgress(0);
          setProgressMsg('');
      }
  };


  const formatGeometry = (geo: any) => {
     if (!geo || !geo.coordinates) return "N/A";
     const type = geo.type;
     const coords = JSON.stringify(geo.coordinates);
     return `${type.toUpperCase()} (${coords.length > 50 ? coords.substring(0, 50) + '...' : coords})`;
  };

  return (
    <div className="max-w-7xl mx-auto flex flex-col space-y-4 pb-24">
      {/* Header & Stats Section */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex-shrink-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-4 gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-800 flex items-center">
              <Database className="mr-2 text-brand-600" />
              Base Maestra de Códigos Postales
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Gestiona la base de datos geográfica (Shapefile) y la base maestra de nombres (Excel).
            </p>
            <div className="mt-2 flex items-center gap-2">
              {muniIndexCount > 0 ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800">
                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full mr-1"></span>
                  Base Maestra: Activa
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800">
                  <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full mr-1"></span>
                  Base Maestra: Inactiva
                </span>
              )}
              {muniIndexCount > 0 && (
                <button onClick={async () => { await clearMunicipalIndex(); await loadMuniIndexStats(); }} className="text-[10px] px-2 py-0.5 rounded border border-red-200 text-red-700 hover:bg-red-50">
                  Limpiar Base Maestra
                </button>
              )}
            </div>
          </div>
          
          <a 
            href="https://www.datos.gov.co/Ordenamiento-Territorial/C-digos-Postales-Nacionales/ixig-z8b5/about_data" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-xs bg-brand-50 text-brand-700 px-3 py-2 rounded-lg border border-brand-100 hover:bg-brand-100 transition-colors flex items-center"
          >
            <ExternalLink className="w-3 h-3 mr-1.5" />
            Descargar Shapefile Oficial
          </a>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          {/* Stats Card */}
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 md:col-span-3 min-h-[140px] flex flex-col justify-between">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Total Zonas</h3>
            <div className="flex items-baseline">
                <span className="text-3xl font-bold text-slate-800">{stats.count.toLocaleString()}</span>
                <span className="ml-2 text-xs text-slate-500 font-medium">registros</span>
            </div>
            <div className="mt-2 flex items-center">
                {stats.count > 0 ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800">
                        <span className="w-1.5 h-1.5 bg-green-500 rounded-full mr-1"></span>
                        Base Activa
                    </span>
                ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800">
                        <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full mr-1"></span>
                        Vacía
                    </span>
                )}
            </div>
          </div>

          {/* Loading Indicator (Overlays both upload buttons if loading) */}
          {loading ? (
             <div className="md:col-span-9 border-2 border-dashed border-brand-300 bg-brand-50/50 rounded-lg p-2 flex flex-col items-center justify-center min-h-[110px]">
                <div className="w-full px-4 text-center">
                    <div className="flex items-center justify-center mb-1 text-brand-600">
                        <RefreshCw className="animate-spin h-5 w-5 mr-2" />
                        <span className="text-xs font-bold">{progress}%</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-1.5 mb-1">
                      <div className="bg-brand-600 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">{progressMsg}</p>
                </div>
             </div>
          ) : (
            <>
              {/* Upload Shapefile */}
              <div className="md:col-span-6 border-2 border-dashed border-brand-200 bg-brand-50/30 rounded-lg p-2 flex flex-col items-center justify-center hover:bg-brand-50 transition-colors relative group min-h-[110px]">
                <label className="cursor-pointer flex flex-col items-center justify-center h-full w-full">
                  <div className="bg-white p-2 rounded-full shadow-sm mb-1 group-hover:scale-110 transition-transform">
                      <FileArchive className="w-5 h-5 text-brand-600" />
                  </div>
                  <span className="text-xs font-bold text-brand-700">1. Cargar Shapefile Geográfico (.zip)</span>
                  <p className="text-[10px] text-brand-400 mt-0.5 text-center px-2">Importa los polígonos y la ubicación</p>
              <input type="file" className="hidden" accept=".zip" onChange={handleShapefileUpload} />
              </label>
              </div>

              <div className="md:col-span-3 bg-white p-4 rounded-lg border-2 border-dashed border-green-300 hover:border-green-400 transition-colors min-h-[110px] flex flex-col justify-center">
                <div className="flex items-center justify-center mb-3">
                  <div className="bg-green-100 p-2 rounded-full">
                    <FileSpreadsheet className="h-5 w-5 text-green-600" />
                  </div>
                </div>
                <h3 className="text-sm font-semibold text-center mb-2">Cargar CSV Oficial</h3>
                <p className="text-sm text-slate-600 text-center mb-4">Índice municipal (datos.gov.co)</p>
                <label className="flex items-center justify-center w-full px-3 py-1.5 border-2 border-green-400 rounded-md cursor-pointer hover:bg-green-50 transition-colors bg-white">
                  <Upload className="h-4 w-4 text-green-600 mr-2" />
                  <span className="text-sm font-medium text-green-700">Seleccionar CSV</span>
                  <input type="file" className="hidden" accept=".csv" onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setIsProcessing(true);
                    setProcessingMessage('Cargando CSV oficial...');
                    try {
                      const reader = new FileReader();
                      reader.onload = async (evt) => {
                        const text = evt.target?.result as string;
                        const wb = XLSX.read(text, { type: 'string', raw: true });
                        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
                        const { loadOfficialPostalCSV } = await import('../services/postalService');
                        const result = await loadOfficialPostalCSV(data as any[]);
                        setProcessingMessage(`✅ ${result.loaded} municipios cargados`);
                        setTimeout(() => setIsProcessing(false), 2000);
                      };
                      reader.readAsText(file, 'utf-8');
                    } catch (error: any) {
                      setProcessingMessage(`Error: ${error.message}`);
                      setTimeout(() => setIsProcessing(false), 3000);
                    }
                  }} />
                </label>
                {isProcessing && (
                  <p className="mt-2 text-xs text-slate-600 text-center">{processingMessage}</p>
                )}
              </div>


              {/* Upload Master Excel */}
              <div className="md:col-span-3 border-2 border-dashed border-green-200 bg-green-50/30 rounded-lg p-2 flex flex-col items-center justify-center hover:bg-green-50 transition-colors relative group min-h-[140px]">
                <label className="cursor-pointer flex flex-col items-center justify-center h-full w-full">
                  <div className="bg-white p-2 rounded-full shadow-sm mb-1 group-hover:scale-110 transition-transform">
                      <FileSpreadsheet className="w-5 h-5 text-green-600" />
                  </div>
                  <span className="text-xs font-bold text-green-700">2. Cargar Maestro (.xlsx)</span>
                  <p className="text-[10px] text-green-500 mt-0.5 text-center">Enriquece nombres de Mpio/Depto</p>
                  <input type="file" className="hidden" accept=".xlsx, .xls" onChange={handleMasterExcelUpload} />
                </label>
              </div>
            </>
          )}
        </div>
        
        {message && (
          <div className={`mt-3 p-3 rounded-lg flex items-center text-xs font-medium ${message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
            <Info className="w-4 h-4 mr-2" />
            {message.text}
          </div>
        )}
      </div>

      {/* Data Table Section */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 flex-1 flex flex-col overflow-auto">
        <div className="px-5 py-4 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4 flex-shrink-0">
          <div className="relative max-w-sm w-full">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Search className="h-4 w-4 text-slate-400" /></div>
            <input 
                type="text" 
                placeholder="Buscar C.P., Municipio o Depto..." 
                className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all placeholder:text-slate-400" 
                value={searchQuery} 
                onChange={(e) => setSearchQuery(e.target.value)} 
            />
          </div>
          <div className="flex items-center space-x-3 text-sm text-slate-600">
             <span className="text-xs font-medium text-slate-400 uppercase">Filas:</span>
             <select className="border border-slate-300 bg-white rounded-md p-1.5 text-slate-700 text-xs focus:ring-brand-500 focus:border-brand-500" value={itemsPerPage} onChange={(e) => setItemsPerPage(Number(e.target.value))}>
               <option value={20}>20</option><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option>
             </select>
          </div>
        </div>
        
        <div className="flex-1 overflow-auto">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-bold text-slate-400 uppercase tracking-wider w-16">ID</th>
                  <th className="px-4 py-2 text-left text-xs font-bold text-slate-400 uppercase tracking-wider">Código Postal</th>
                  <th className="px-4 py-2 text-left text-xs font-bold text-slate-400 uppercase tracking-wider">Municipio</th>
                  <th className="px-4 py-2 text-left text-xs font-bold text-slate-400 uppercase tracking-wider">Departamento</th>
                  <th className="px-4 py-2 text-left text-xs font-bold text-slate-400 uppercase tracking-wider">Polígono</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-50">
                {result.data.length > 0 ? (
                  result.data.map((row) => (
                    <tr key={row.id} className="hover:bg-brand-50/30 transition-colors group">
                      <td className="px-4 py-2 text-slate-300 text-xs font-mono">{row.id.replace('feat-','')}</td>
                      <td className="px-4 py-2">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-brand-100 text-brand-800 font-mono">
                            {row.codigo_postal}
                          </span>
                      </td>
                      <td className="px-4 py-2">
                          <div className={`font-medium ${row.nombre_municipio === 'Desconocido' ? 'text-red-400 italic' : 'text-slate-800'}`}>
                            {row.nombre_municipio}
                          </div>
                          <div className="text-[10px] text-slate-400">Cod: {row.codigo_municipio || 'N/A'}</div>
                      </td>
                      <td className="px-4 py-2 text-slate-600">{row.nombre_departamento || '-'}</td>
                      <td className="px-4 py-2 text-xs font-mono text-slate-400 max-w-xs truncate" title="Coordenadas GeoJSON">
                          {formatGeometry(row.geometry)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                      <td colSpan={5} className="px-6 py-16 text-center">
                          <div className="flex flex-col items-center justify-center text-slate-400">
                              <Database className="w-8 h-8 mb-2 opacity-20" />
                              <p className="text-sm">No se encontraron registros</p>
                              <p className="text-xs opacity-60">Intenta cargar un Shapefile o ajustar la búsqueda</p>
                          </div>
                      </td>
                  </tr>
                )}
              </tbody>
            </table>
        </div>

        {/* Pagination Footer */}
        <div className="bg-white px-5 py-3 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
            <div className="text-xs text-slate-500 hidden sm:block">
              Mostrando <span className="font-bold text-slate-700">{(result.page - 1) * itemsPerPage + 1}</span> - <span className="font-bold text-slate-700">{Math.min(result.page * itemsPerPage, result.total)}</span> de <span className="font-bold text-slate-700">{result.total.toLocaleString()}</span>
            </div>
            <div className="flex space-x-1 mx-auto sm:mx-0">
              <button onClick={() => setPage(1)} disabled={result.page === 1} className="p-1.5 border border-slate-200 rounded-md bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronsLeft className="h-4 w-4" /></button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={result.page === 1} className="p-1.5 border border-slate-200 rounded-md bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronLeft className="h-4 w-4" /></button>
              
              <div className="flex items-center px-4 py-1 border border-slate-200 bg-slate-50 text-xs font-bold rounded-md text-slate-700">
                Pág. {result.page} / {result.totalPages || 1}
              </div>

              <button onClick={() => setPage(p => Math.min(result.totalPages, p + 1))} disabled={result.page === result.totalPages || result.totalPages === 0} className="p-1.5 border border-slate-200 rounded-md bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronRight className="h-4 w-4" /></button>
              <button onClick={() => setPage(result.totalPages)} disabled={result.page === result.totalPages || result.totalPages === 0} className="p-1.5 border border-slate-200 rounded-md bg-white text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"><ChevronsRight className="h-4 w-4" /></button>
            </div>
        </div>
      </div>
    </div>
  );
};

export default DatabaseView;

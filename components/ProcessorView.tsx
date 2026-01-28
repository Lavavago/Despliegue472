import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Upload, Play, Download, FileSpreadsheet, AlertTriangle, Check, ArrowRight, BarChart3, Loader2, Pencil, X, Save, Square } from 'lucide-react';
import * as XLSX from 'xlsx';
import { processTemplateBatch, processTemplateTurbo, reprocessSingleRow } from '../services/postalService';
import { AddressTemplate, ProcessStatus } from '../types';

const ProcessorView: React.FC = () => {
  const [status, setStatus] = useState<ProcessStatus>(ProcessStatus.IDLE);
  const [data, setData] = useState<AddressTemplate[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [speed, setSpeed] = useState<number>(0);
  const [eta, setEta] = useState<string>('');
  const [turbo, setTurbo] = useState<boolean>(false);
  const [itemsPerPage, setItemsPerPage] = useState<number>(50);
  const [page, setPage] = useState<number>(1);
  const startTsRef = useRef<number | null>(null);
  const lastPctRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('processorState');
      if (raw) {
        const st = JSON.parse(raw);
        if (Array.isArray(st.data)) setData(st.data);
        if (st.status) setStatus(st.status);
        if (st.fileName) setFileName(st.fileName);
      }
      const turboRaw = localStorage.getItem('processorTurbo');
      if (turboRaw) setTurbo(turboRaw === '1');
    } catch {}
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'processorState' && e.newValue) {
        try {
          const st = JSON.parse(e.newValue);
          if (Array.isArray(st.data)) setData(st.data);
          if (st.status) setStatus(st.status);
          if (st.fileName) setFileName(st.fileName);
        } catch {}
      } else if (e.key === 'processorTurbo') {
        setTurbo(e.newValue === '1');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    try {
      const st = { data, status, fileName };
      localStorage.setItem('processorState', JSON.stringify(st));
    } catch {}
  }, [data, status, fileName]);

  useEffect(() => {
    try { localStorage.setItem('processorTurbo', turbo ? '1' : '0'); } catch {}
  }, [turbo]);

  // Stop Controller
  const abortControllerRef = useRef<AbortController | null>(null);

  // Modal State
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<AddressTemplate | null>(null);
  const [editForm, setEditForm] = useState({ address: '', city: '', dane: '', dept: '' });
  const [isRetrying, setIsRetrying] = useState(false);

  // Calculate statistics
  const stats = useMemo(() => {
    const total = data.length;
    if (total === 0) return { total: 0, found: 0, missing: 0, foundPct: 0, missingPct: 0 };
    
    const processed = data.filter(d => d.codigo_postal_asignado !== undefined);
    if (processed.length === 0) return { total, found: 0, missing: 0, foundPct: 0, missingPct: 0 };

    const missing = data.filter(d => 
      !d.codigo_postal_asignado || d.codigo_postal_asignado.length > 6 || isNaN(Number(d.codigo_postal_asignado))
    ).length;
    
    const found = total - missing;

    return {
      total,
      found,
      missing,
      foundPct: Math.round((found / total) * 100),
      missingPct: Math.round((missing / total) * 100)
    };
  }, [data]);

  const pagedData = useMemo(() => {
    const start = (page - 1) * itemsPerPage;
    return data.slice(start, start + itemsPerPage);
  }, [data, page, itemsPerPage]);
  const totalPages = useMemo(() => Math.max(1, Math.ceil(data.length / itemsPerPage)), [data.length, itemsPerPage]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setStatus(ProcessStatus.UPLOADING);
    setErrorMessage('');
    setProgress(0);

    const reader = new FileReader();
    reader.onload = (evt) => {
      const result = evt.target?.result as string;
      const isCsv = file.name.toLowerCase().endsWith('.csv');
      const wb = isCsv ? XLSX.read(result, { type: 'string', raw: true }) : XLSX.read(result, { type: 'binary' });
      
      const wsname = wb.SheetNames.find(n => n.includes('Reporteador')) || wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const jsonData = XLSX.utils.sheet_to_json(ws);
      
      const cleanCurrency = (v: any) => {
        const s = String(v ?? '').trim();
        const digits = s.replace(/\D/g, '');
        if (!digits) return 0;
        return Number(digits);
      };
      const cleanAddress = (v: any) => String(v ?? '')
        .replace(/[\,;\|:\<\>\"'`~^]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const trimVal = (v: any) => String(v ?? '').trim();
      const ensureDane5 = (v: any) => {
        const digits = String(v ?? '').replace(/\D/g, '');
        if (digits.length >= 1) return digits.padStart(5, '0').slice(-5);
        return '00000';
      };

      const cleanedRows = (jsonData as any[])
        .map((row: any) => {
          const r: any = { ...row };
          if (r['Valor declarado'] !== undefined) r['Valor declarado'] = cleanCurrency(r['Valor declarado']);
          if (r['Dirección'] !== undefined) r['Dirección'] = cleanAddress(r['Dirección']);
          if (r['direccion'] !== undefined) r['direccion'] = cleanAddress(r['direccion']);
          if (r['DANE origen'] !== undefined) r['DANE origen'] = ensureDane5(r['DANE origen']);
          if (r['DANE destino'] !== undefined) r['DANE destino'] = ensureDane5(r['DANE destino']);
          return r;
        })
        .filter((r: any) => {
          const dane = trimVal(r['DANE destino'] || r['dane_destino']);
          const city = trimVal(r['Ciudad de destino'] || r['ciudad_destino']);
          const addr = trimVal(r['Dirección'] || r['direccion']);
          const dept = trimVal(r['Departamento de destino'] || r['departamento_destino'] || r['departamento']);
          return !!(dane || city || addr || dept);
        });
      
      const mappedData: AddressTemplate[] = cleanedRows.map((row: any, idx) => {
        const rawAddr = row['Dirección'] || row['direccion'] || '';
        const cleanAddr = String(rawAddr).trim();

        // Fix DANE code Padding (Requirement: 5 digits, padStart with 0)
        const rawDane = row['DANE destino'] || row['dane_destino'] || '';
        const paddedDane = rawDane ? String(rawDane).replace(/\D/g, '').padStart(5, '0').slice(-5) : '00000';

        return {
          id: `prev-${idx}`,
          dane_destino: paddedDane,
          ciudad_destino: row['Ciudad de destino'] || row['ciudad_destino'],
          departamento_destino: row['Departamento de destino'] || row['departamento_destino'] || row['departamento'],
          direccion: cleanAddr, 
          codigo_postal_asignado: undefined,
          coordenadas: undefined,
          originalData: { ...row, 'DANE destino': paddedDane } 
        };
      });

      setData(mappedData);
      setPage(1);
      setStatus(ProcessStatus.IDLE);
    };
    const isCsv = file.name.toLowerCase().endsWith('.csv');
    if (isCsv) {
      reader.readAsText(file, 'utf-8');
    } else {
      reader.readAsBinaryString(file);
    }
  };

  const handleProcess = async () => {
    if (data.length === 0) return;
    
    setStatus(ProcessStatus.PROCESSING);
    setErrorMessage('');
    setProgress(0);
    setSpeed(0);
    setEta('');
    startTsRef.current = Date.now();
    lastPctRef.current = 0;
    lastTsRef.current = Date.now();
    
    // Create new abort controller
    abortControllerRef.current = new AbortController();
    
    try {
      const rawInput = data.map(d => ({
        'DANE destino': d.dane_destino,
        'Ciudad de destino': d.ciudad_destino,
        'Departamento de destino': d.departamento_destino,
        'Dirección': d.direccion 
      }));

      // Pass signal to service
      const results = await (turbo ? processTemplateTurbo : processTemplateBatch)(
          rawInput, 
          (pct) => setProgress(pct),
          abortControllerRef.current.signal
      );
      
      // Merge results back with original data
      const mergedResults = results.map((res, i) => ({
          ...res,
          originalData: data[i].originalData
      }));
      
      // If we got partial results because we stopped, we fill the rest with existing data (unprocessed)
      // This logic depends on whether processTemplateBatch returns partial or throws. 
      // Current impl returns partial array if stopped.
      
      if (results.length < data.length) {
          // Fill remaining
          const fullResults = [...data];
          for(let i=0; i<results.length; i++) {
              fullResults[i] = { ...results[i], originalData: data[i].originalData };
          }
          setData(fullResults);
          setStatus(ProcessStatus.IDLE); // Stopped state
      } else {
          setData(mergedResults);
          setStatus(ProcessStatus.COMPLETED);
      }
      
    } catch (error: any) {
      console.error(error);
      if (error.name === 'AbortError') {
          setStatus(ProcessStatus.IDLE);
      } else {
          setStatus(ProcessStatus.ERROR);
          setErrorMessage(error.message || "Error al procesar.");
      }
    } finally {
        abortControllerRef.current = null;
    }
  };

  useEffect(() => {
    if (status !== ProcessStatus.PROCESSING) return;
    const now = Date.now();
    const lastPct = lastPctRef.current;
    const lastTs = lastTsRef.current || now;
    const deltaPct = Math.max(0, progress - lastPct);
    const deltaTime = Math.max(1, now - lastTs);
    if (deltaPct > 0) {
      const pctPerSec = (deltaPct / deltaTime) * 1000;
      setSpeed(pctPerSec);
      const remainingPct = Math.max(0, 100 - progress);
      const secondsLeft = remainingPct / Math.max(0.01, pctPerSec);
      const mins = Math.floor(secondsLeft / 60);
      const secs = Math.max(0, Math.floor(secondsLeft % 60));
      setEta(`${mins}m ${secs}s`);
      lastPctRef.current = progress;
      lastTsRef.current = now;
    }
  }, [progress, status]);

  const handleStop = () => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
          setStatus(ProcessStatus.IDLE);
      }
  };

  const handleExport = () => {
    const exportData = data.map(d => ({
        ...d.originalData,
        'Codigo postal 472': d.codigo_postal_asignado || '',
        'Coordenada': d.coordenadas || ''
    }));

    const keySet = new Set<string>();
    const preferredOrder = [
      'DANE origen','DANE destino','Ciudad de destino','Departamento de destino','Dirección','Valor declarado',
      'Codigo postal 472','Coordenada'
    ];
    exportData.forEach(row => Object.keys(row).forEach(k => keySet.add(k)));
    const headers: string[] = [];
    preferredOrder.forEach(h => { if (keySet.has(h)) headers.push(h); });
    Array.from(keySet).forEach(k => { if (!headers.includes(k)) headers.push(k); });

    const quoteCSV = (val: any) => {
      let s = val === null || val === undefined ? '' : String(val);
      s = s.replace(/"/g, '""');
      if (/\s/.test(s) || /,/.test(s)) return `"${s}"`;
      return s;
    };

    const lines: string[] = [];
    lines.push(headers.join(','));
    exportData.forEach(row => {
      const line = headers.map(h => quoteCSV(row[h])).join(',');
      lines.push(line);
    });
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Reporteador_Con_Codigos.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // EDIT HANDLERS
  const openEditModal = (row: AddressTemplate) => {
      setEditingRow(row);
      setEditForm({
          address: row.direccion,
          city: row.ciudad_destino,
          dane: row.dane_destino,
          dept: row.departamento_destino || ''
      });
      setIsEditModalOpen(true);
  };

  const closeEditModal = () => {
      setIsEditModalOpen(false);
      setEditingRow(null);
  };

  const handleSaveEdit = async () => {
      if (!editingRow) return;
      setIsRetrying(true);

      try {
          const updatedTemp: AddressTemplate = {
              ...editingRow,
              direccion: editForm.address,
              ciudad_destino: editForm.city,
              departamento_destino: editForm.dept,
              dane_destino: editForm.dane,
              originalData: {
                  ...editingRow.originalData,
                  'Dirección': editForm.address,
                  'Ciudad de destino': editForm.city,
                  'Departamento de destino': editForm.dept,
                  'DANE destino': editForm.dane
              }
          };

          const processed = await reprocessSingleRow(updatedTemp);
          
          setData(prev => prev.map(item => item.id === editingRow.id ? processed : item));
          closeEditModal();
      } catch (e) {
          console.error(e);
          alert("Error al re-procesar el registro.");
      } finally {
          setIsRetrying(false);
      }
  };

  return (
    <div className="max-w-6xl mx-auto h-[calc(100vh-8rem)] flex flex-col space-y-4 relative">
      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 flex-shrink-0">
        <h2 className="text-xl font-bold text-slate-800 flex items-center mb-2">
          <FileSpreadsheet className="mr-2 text-blue-600" />
          Procesador de Plantilla (Reporteador)
        </h2>
        
        <p className="text-sm text-slate-600 mb-4">
          Valida cada dirección geolocalizándola y verificando si cae dentro de los polígonos del Shapefile cargado.
        </p>

        {status === ProcessStatus.PROCESSING && (
            <div className="mb-4">
              <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-semibold text-blue-600">Procesando registros...</span>
                    <span className="text-xs font-bold text-blue-600">{progress}%</span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2.5">
                  <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-300 ease-out" style={{ width: `${progress}%` }}></div>
              </div>
              <div className="flex justify-between items-center mt-1">
                 <span className="text-[10px] text-slate-500">Velocidad: {speed.toFixed(1)}%/s</span>
                 <span className="text-[10px] text-slate-500">ETA: {eta || 'calculando...'}</span>
              </div>
              <div className="mt-2 w-full h-1 bg-gradient-to-r from-blue-200 via-blue-300 to-blue-200 animate-pulse rounded"></div>
            </div>
        )}

        <div className="flex flex-col md:flex-row gap-3 items-center bg-slate-50 p-3 rounded-lg border border-slate-200">
            <div className="flex-1 w-full">
               <label className="flex items-center justify-center w-full px-4 py-2 border-2 border-dashed border-slate-300 rounded-md cursor-pointer hover:border-blue-400 hover:bg-white transition-colors bg-white">
                  <Upload className="h-4 w-4 text-slate-400 mr-2" />
                  <span className="text-sm font-medium text-slate-600 truncate max-w-[200px] md:max-w-xs">
                    {fileName ? fileName : "Cargar Plantilla Reporteador.xlsx"}
                  </span>
                  <input type="file" className="hidden" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} />
               </label>
            </div>

            <ArrowRight className="hidden md:block text-slate-300 h-5 w-5" />

            {/* PROCESS CONTROLS */}
            <div className="flex gap-2 w-full md:w-auto">
                <label className="flex items-center px-3 py-2 border border-slate-300 bg-white rounded-md text-xs text-slate-700">
                  <input type="checkbox" className="mr-2" checked={turbo} onChange={(e) => setTurbo(e.target.checked)} />
                  Modo Turbo 20s
                </label>
                <button
                  onClick={handleProcess}
                  disabled={data.length === 0 || status === ProcessStatus.PROCESSING || status === ProcessStatus.COMPLETED}
                  className={`flex-1 md:flex-none px-4 py-2 rounded-md font-medium text-sm flex items-center justify-center space-x-2 transition-all ${
                    data.length === 0 ? 'bg-slate-200 text-slate-400 cursor-not-allowed' :
                    status === ProcessStatus.PROCESSING ? 'bg-blue-700 text-white cursor-wait' :
                    status === ProcessStatus.COMPLETED ? 'bg-green-600 text-white cursor-default' :
                    'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                  }`}
                >
                  {status === ProcessStatus.PROCESSING ? (
                    <>
                      <Loader2 className="animate-spin h-4 w-4 mr-2" />
                      <span>Procesando...</span>
                    </>
                  ) : status === ProcessStatus.COMPLETED ? (
                    <>
                      <Check className="h-4 w-4" />
                      <span>Completado</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 fill-current" />
                      <span>Ejecutar Validación</span>
                    </>
                  )}
                </button>

                {status === ProcessStatus.PROCESSING && (
                    <button
                        onClick={handleStop}
                        className="px-3 py-2 bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors border border-red-200 flex items-center"
                        title="Detener Proceso"
                    >
                        <Square className="h-4 w-4 fill-current" />
                        <span className="ml-2 text-sm font-bold">Detener</span>
                    </button>
                )}
            </div>
            
            {(status === ProcessStatus.COMPLETED || (data.length > 0 && status === ProcessStatus.IDLE && stats.found > 0)) && (
              <button
                onClick={handleExport}
                className="w-full md:w-auto px-4 py-2 bg-yellow-400 text-yellow-900 rounded-md text-sm font-bold flex items-center justify-center hover:bg-yellow-500 shadow-sm transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                Excel
              </button>
            )}
        </div>
        {status === ProcessStatus.ERROR && (
           <div className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded border border-red-100 font-medium">
             {errorMessage}
           </div>
        )}
      </div>

      {/* STATISTICS DASHBOARD */}
      {data.length > 0 && stats.total > 0 && (
         <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-shrink-0">
            <div className="bg-white p-3 rounded-lg shadow-sm border border-slate-200 flex items-center">
               <div className="bg-slate-100 p-2 rounded-full mr-3">
                 <BarChart3 className="text-slate-600 h-5 w-5" />
               </div>
               <div>
                 <p className="text-[10px] text-slate-500 font-semibold uppercase">Total</p>
                 <p className="text-xl font-bold text-slate-900">{stats.total.toLocaleString()}</p>
               </div>
            </div>

            <div className="bg-white p-3 rounded-lg shadow-sm border border-l-4 border-green-500 flex items-center">
               <div className="bg-green-100 p-2 rounded-full mr-3">
                 <Check className="text-green-600 h-5 w-5" />
               </div>
               <div>
                 <p className="text-[10px] text-slate-500 font-semibold uppercase">Encontrados</p>
                 <div className="flex items-baseline space-x-2">
                   <p className="text-xl font-bold text-green-700">{stats.found.toLocaleString()}</p>
                   <span className="text-xs text-green-600 font-medium">({stats.foundPct}%)</span>
                 </div>
               </div>
            </div>

            <div className="bg-white p-3 rounded-lg shadow-sm border border-l-4 border-red-500 flex items-center">
               <div className="bg-red-100 p-2 rounded-full mr-3">
                 <AlertTriangle className="text-red-600 h-5 w-5" />
               </div>
               <div>
                 <p className="text-[10px] text-slate-500 font-semibold uppercase">Pendientes / Error</p>
                 <div className="flex items-baseline space-x-2">
                   <p className="text-xl font-bold text-red-700">{stats.missing.toLocaleString()}</p>
                   <span className="text-xs text-red-600 font-medium">({stats.missingPct}%)</span>
                 </div>
               </div>
            </div>
         </div>
      )}

      {/* Results Table */}
      {data.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 flex-1 flex flex-col overflow-hidden">
          <div className="px-6 py-3 border-b border-slate-200 bg-slate-50 flex justify-between items-center flex-shrink-0">
             <h3 className="font-semibold text-slate-700 text-sm">
               Vista Previa de Datos
             </h3>
             <div className="flex items-center gap-2">
               {status === ProcessStatus.COMPLETED && (
                 <span className="text-xs font-semibold bg-green-100 text-green-800 px-2 py-1 rounded-full">Proceso Finalizado</span>
               )}
               <select className="border border-slate-300 bg-white rounded-md p-1.5 text-slate-700 text-xs" value={itemsPerPage} onChange={(e) => setItemsPerPage(Number(e.target.value))}>
                 <option value={50}>50</option>
                 <option value={100}>100</option>
                 <option value={200}>200</option>
               </select>
               <div className="flex items-center gap-1 text-xs">
                 <button className="px-2 py-1 border border-slate-300 rounded" disabled={page<=1} onClick={() => setPage(p => Math.max(1, p-1))}>‹</button>
                 <span>{page}/{totalPages}</span>
                 <button className="px-2 py-1 border border-slate-300 rounded" disabled={page>=totalPages} onClick={() => setPage(p => Math.min(totalPages, p+1))}>›</button>
               </div>
             </div>
          </div>
          <div className="flex-1 overflow-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-slate-500 uppercase tracking-wider w-10"></th>
                  <th className="px-6 py-3 text-left font-medium text-slate-500 uppercase tracking-wider w-24">DANE</th>
                  <th className="px-6 py-3 text-left font-medium text-slate-500 uppercase tracking-wider w-40">Ciudad</th>
                  <th className="px-6 py-3 text-left font-medium text-slate-500 uppercase tracking-wider">Dirección</th>
                   <th className="px-6 py-3 text-left font-medium text-slate-500 uppercase tracking-wider w-32">Coordenada</th>
                  <th className="px-6 py-3 text-left font-medium text-slate-500 uppercase tracking-wider bg-yellow-50 w-40 border-l border-yellow-100">
                    Código Postal
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-200">
                {pagedData.map((row) => {
                    const hasError = !row.codigo_postal_asignado || row.codigo_postal_asignado.length > 6 || isNaN(Number(row.codigo_postal_asignado));
                    return (
                        <tr key={row.id} className="hover:bg-slate-50 group">
                            <td className="px-4 py-3 whitespace-nowrap">
                                {hasError && (
                                    <button 
                                        onClick={() => openEditModal(row)}
                                        title="Editar Dirección Manualmente"
                                        className="text-slate-400 hover:text-blue-600 transition-colors p-1 rounded hover:bg-blue-50"
                                    >
                                        <Pencil size={14} />
                                    </button>
                                )}
                            </td>
                            <td className="px-6 py-3 whitespace-nowrap text-slate-500 font-mono">{row.dane_destino}</td>
                            <td className="px-6 py-3 whitespace-nowrap text-slate-900">{row.ciudad_destino}</td>
                            <td className="px-6 py-3 text-slate-600">{row.direccion}</td>
                            <td className="px-6 py-3 text-xs font-mono text-slate-400">{row.coordenadas || '-'}</td>
                            <td className={`px-6 py-3 whitespace-nowrap font-bold border-l ${
                            hasError
                                ? 'text-red-500 bg-red-50' 
                                : 'text-blue-600 bg-yellow-50'
                            }`}>
                            {row.codigo_postal_asignado || "---"}
                            </td>
                        </tr>
                    );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {isEditModalOpen && editingRow && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 rounded-lg backdrop-blur-sm">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all animate-in fade-in zoom-in-95 duration-200">
                  <div className="bg-slate-50 px-6 py-4 border-b border-slate-100 flex justify-between items-center">
                      <h3 className="font-bold text-slate-800 flex items-center">
                          <Pencil size={16} className="mr-2 text-blue-600" />
                          Corregir Dirección
                      </h3>
                      <button onClick={closeEditModal} className="text-slate-400 hover:text-slate-600">
                          <X size={18} />
                      </button>
                  </div>
                  <div className="p-6 space-y-4">
                      <div>
                          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Dirección</label>
                          <input 
                              type="text" 
                              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              value={editForm.address}
                              onChange={e => setEditForm({...editForm, address: e.target.value})}
                          />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                          <div>
                              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Ciudad</label>
                              <input 
                                  type="text" 
                                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                  value={editForm.city}
                                  onChange={e => setEditForm({...editForm, city: e.target.value})}
                              />
                          </div>
                          <div>
                              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Departamento</label>
                              <input 
                                  type="text" 
                                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                  value={editForm.dept}
                                  onChange={e => setEditForm({...editForm, dept: e.target.value})}
                                  placeholder="(Opcional)"
                              />
                          </div>
                          <div className="col-span-2">
                              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">DANE</label>
                              <input 
                                  type="text" 
                                  className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                  value={editForm.dane}
                                  onChange={e => setEditForm({...editForm, dane: e.target.value})}
                              />
                          </div>
                      </div>
                      <div className="pt-2 bg-yellow-50 p-3 rounded border border-yellow-100 text-xs text-yellow-800">
                          Al guardar, se intentará geolocalizar nuevamente esta dirección específica.
                      </div>
                  </div>
                  <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end space-x-2">
                      <button 
                          onClick={closeEditModal}
                          className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md"
                      >
                          Cancelar
                      </button>
                      <button 
                          onClick={handleSaveEdit}
                          disabled={isRetrying}
                          className="px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-md shadow-sm flex items-center"
                      >
                          {isRetrying ? <Loader2 size={14} className="animate-spin mr-2" /> : <Save size={14} className="mr-2" />}
                          Guardar y Re-procesar
                      </button>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};

export default ProcessorView;
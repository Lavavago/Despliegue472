import React, { useState, useEffect, useRef } from 'react';
import { Map as MapIcon, Search, Info, Loader2, X, MapPin, Hash, Building2, Navigation, Globe } from 'lucide-react';
import L from 'leaflet';
import { getAllPostalZones, searchExternalLocations, findZoneByPoint } from '../services/postalService';
import { PostalZone } from '../types';

// Default center (Bogota)
const DEFAULT_CENTER: [number, number] = [4.5709, -74.2973]; 

const iconDefault = L.icon({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  tooltipAnchor: [16, -28],
  shadowSize: [41, 41]
});
L.Marker.prototype.options.icon = iconDefault;

type SearchMode = 'address' | 'cp' | 'muni' | 'depto';

const normalizeStr = (str: string) => str ? str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "";

const MapView: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('address');
  const [loadingData, setLoadingData] = useState(true);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchSuccess, setSearchSuccess] = useState<string | null>(null);
  
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markerLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const highlightLayerRef = useRef<L.LayerGroup | null>(null); 
  
  const allZonesRef = useRef<PostalZone[]>([]);

  useEffect(() => {
    // Initialize Map
    if (mapContainerRef.current && !mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current).setView(DEFAULT_CENTER, 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      
      layerGroupRef.current = L.layerGroup().addTo(map); // Main zones
      highlightLayerRef.current = L.layerGroup().addTo(map); // Secondary highlights
      markerLayerGroupRef.current = L.layerGroup().addTo(map); // Address markers
      
      mapInstanceRef.current = map;

      setTimeout(() => {
         map.invalidateSize();
      }, 300);
      
      // Async load data from IndexedDB
      getAllPostalZones().then(zones => {
          allZonesRef.current = zones;
          setLoadingData(false);
      }).catch(err => {
          console.error("Error loading map data", err);
          setLoadingData(false);
      });
    }
    
    return () => { if (mapInstanceRef.current) { mapInstanceRef.current.remove(); mapInstanceRef.current = null; } };
  }, []);

  const clearMapLayers = () => {
      if (layerGroupRef.current) layerGroupRef.current.clearLayers();
      if (markerLayerGroupRef.current) markerLayerGroupRef.current.clearLayers();
      if (highlightLayerRef.current) highlightLayerRef.current.clearLayers();
  };

  useEffect(() => {
    setSearchTerm('');
    clearMapLayers();
    setLoadingSearch(false);
    setSearchError(null);
    setSearchSuccess(null);
  }, [searchMode]);

  const loadMuniZones = (muniName: string) => {
      if (!layerGroupRef.current || !mapInstanceRef.current) return;

      const searchNorm = normalizeStr(muniName);
      let zones = allZonesRef.current.filter(z => 
          normalizeStr(z.nombre_municipio) === searchNorm
      );

      if (zones.length === 0) {
          alert(`No se encontró el municipio "${muniName}" en la base de datos (Búsqueda exacta).`);
          return;
      }
      
      clearMapLayers();
      const featureGroup = new L.FeatureGroup();

      zones.forEach(zone => {
          const layer = L.geoJSON(zone.geometry as any, {
              style: {
                  color: '#9333ea',
                  weight: 2,
                  fillColor: '#a855f7',
                  fillOpacity: 0.1
              }
          }).addTo(layerGroupRef.current!);
          
          layer.bindPopup(`
              <div class="font-sans">
                 <h3 class="font-bold text-lg text-purple-800">C.P. ${zone.codigo_postal}</h3>
                 <div class="text-sm font-semibold text-slate-700">${zone.nombre_municipio}</div>
                 <div class="text-xs text-slate-500">${zone.nombre_departamento}</div>
              </div>
          `);

          if (zone.codigo_postal) {
              layer.bindTooltip(zone.codigo_postal, {
                  permanent: true,
                  direction: "center",
                  className: "cp-label-tooltip",
                  interactive: false 
              });
          }
          featureGroup.addLayer(layer);
      });
      
      if (zones.length > 0) {
        const bounds = featureGroup.getBounds();
        if (bounds.isValid()) {
            mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50] });
        }
      }
  };

  const loadDeptoZones = (deptoName: string) => {
      if (!layerGroupRef.current || !mapInstanceRef.current) return;

      const searchNorm = normalizeStr(deptoName);
      let zones = allZonesRef.current.filter(z => 
          normalizeStr(z.nombre_departamento) === searchNorm
      );

      if (zones.length === 0) {
          alert(`No se encontró el departamento "${deptoName}" en la base de datos (Búsqueda exacta).`);
          return;
      }
      
      clearMapLayers();
      const featureGroup = new L.FeatureGroup();

      zones.forEach(zone => {
          const layer = L.geoJSON(zone.geometry as any, {
              style: {
                  color: '#ea580c',
                  weight: 1,
                  fillColor: '#f97316',
                  fillOpacity: 0.1
              }
          }).addTo(layerGroupRef.current!);
          
          layer.bindPopup(`
              <div class="font-sans">
                 <h3 class="font-bold text-lg text-orange-800">C.P. ${zone.codigo_postal}</h3>
                 <div class="text-sm font-semibold text-slate-700">${zone.nombre_municipio}</div>
                 <div class="text-xs text-slate-500">${zone.nombre_departamento}</div>
              </div>
          `);

          if (zone.codigo_postal) {
              layer.bindTooltip(zone.codigo_postal, {
                  permanent: true,
                  direction: "center",
                  className: "cp-label-tooltip",
                  interactive: false 
              });
          }
          featureGroup.addLayer(layer);
      });
      
      if (zones.length > 0) {
        const bounds = featureGroup.getBounds();
        if (bounds.isValid()) {
            mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50] });
        }
      }
  };

  const loadCPZones = (cp: string) => {
      const searchNorm = cp.trim();
      const zones = allZonesRef.current.filter(z => z.codigo_postal === searchNorm);
      
      if (zones.length === 0) {
          alert(`No se encontró el Código Postal "${cp}" en la base de datos.`);
          return;
      }

      if (!layerGroupRef.current || !mapInstanceRef.current) return;
      
      clearMapLayers();
      const featureGroup = new L.FeatureGroup();

      zones.forEach(zone => {
          const layer = L.geoJSON(zone.geometry as any, {
              style: {
                  color: '#2563eb',
                  weight: 3,
                  fillColor: '#3b82f6',
                  fillOpacity: 0.4
              }
          }).addTo(layerGroupRef.current!);
          
          layer.bindPopup(`
              <div class="font-sans">
                 <h3 class="font-bold text-lg text-blue-800">C.P. ${zone.codigo_postal}</h3>
                 <div class="text-sm font-semibold text-slate-700">${zone.nombre_municipio}</div>
                 <div class="text-xs text-slate-500">${zone.nombre_departamento}</div>
              </div>
          `).openPopup();
          featureGroup.addLayer(layer);
      });

      if (zones.length > 0) {
        const bounds = featureGroup.getBounds();
        if (bounds.isValid()) {
             mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50] });
        }
      }
  };

  const handleManualSearch = async () => {
    if (!searchTerm || searchTerm.trim().length < 2) return;

    setLoadingSearch(true);
    setSearchError(null);
    setSearchSuccess(null);
    clearMapLayers();

    try {
        if (searchMode === 'address') {
            const addressesFound = await searchExternalLocations(searchTerm);
            if (addressesFound.length > 0) {
                displayItem({ type: 'ADDRESS', data: addressesFound[0].data });
                setSearchSuccess("Dirección encontrada y ubicada en el mapa.");
            } else {
                setSearchError("Dirección no encontrada. Intente ser más específico (ej: Calle 59 # 2C-76, Cali)");
            }
        } else if (searchMode === 'muni') {
            loadMuniZones(searchTerm);
            setSearchSuccess("Municipio localizado en el mapa.");
        } else if (searchMode === 'cp') {
            loadCPZones(searchTerm);
            setSearchSuccess("Código postal localizado en el mapa.");
        } else if (searchMode === 'depto') {
            loadDeptoZones(searchTerm);
            setSearchSuccess("Departamento localizado en el mapa.");
        }
    } catch (e: any) {
        console.error("Search failed", e);
        const msg = e?.message?.toString().toLowerCase() || '';
        if (msg.includes('403') || msg.includes('permission') || msg.includes('quota') || msg.includes('429')) {
           setSearchError("Error de API: Verifica tu API KEY de Google Gemini o la cuota disponible.");
        } else {
           setSearchError("Error en la búsqueda. Revisa la consola del navegador para más detalles.");
        }
    } finally {
        setLoadingSearch(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
        handleManualSearch();
    }
  };

  const displayItem = (item: any) => {
      if (!layerGroupRef.current || !mapInstanceRef.current || !markerLayerGroupRef.current || !highlightLayerRef.current) return;
      
      clearMapLayers();
      
      if (item.type === 'ADDRESS') {
          const addr = item.data;
          const marker = L.marker([addr.lat, addr.lon]).addTo(markerLayerGroupRef.current);
          
          if (allZonesRef.current.length > 0) {
              const containingZone = findZoneByPoint(addr.lat, addr.lon, allZonesRef.current);
              
              if (containingZone) {
                  const polyLayer = L.geoJSON(containingZone.geometry as any, {
                    style: {
                        color: '#16a34a',
                        weight: 3,
                        fillColor: '#22c55e',
                        fillOpacity: 0.1,
                        dashArray: '5, 5'
                    }
                  }).addTo(highlightLayerRef.current);
                  
                  mapInstanceRef.current.setView([addr.lat, addr.lon], 18);
                  marker.bindPopup(`
                    <div class="font-sans max-w-xs">
                         <div class="text-xs font-bold text-green-600 uppercase mb-1">Zona Postal Detectada</div>
                         <h3 class="font-bold text-xl text-slate-800">${containingZone.codigo_postal}</h3>
                         <div class="text-xs text-slate-500 mb-1">Polígono Válido</div>
                         <div class="border-t border-slate-200 my-1"></div>
                         <div class="text-xs text-slate-600">${addr.display_name}</div>
                    </div>
                  `).openPopup();
              } else {
                  mapInstanceRef.current.setView([addr.lat, addr.lon], 18);
                  marker.bindPopup(`
                    <div class="font-sans max-w-xs">
                         <div class="text-xs font-bold text-red-500 uppercase mb-1">Sin Cobertura 472</div>
                         <div class="text-xs text-slate-600">${addr.display_name}</div>
                    </div>
                  `).openPopup();
              }
          } else {
              mapInstanceRef.current.setView([addr.lat, addr.lon], 18);
          }
      }
  };

  return (
    <div className="max-w-7xl mx-auto h-[calc(100vh-8rem)] flex flex-col relative">
      <style>{`
        .cp-label-tooltip {
          background: transparent;
          border: none;
          box-shadow: none;
          font-size: 14px; /* Aumentado para mejor visibilidad */
          font-weight: 900;
          color: #581c87; /* purple-900 */
          text-shadow: 
             -2px -2px 0 #fff,  
              2px -2px 0 #fff,
             -2px  2px 0 #fff,
              2px  2px 0 #fff;
          opacity: 0.85;
          pointer-events: none; /* Crucial para que no bloquee clics */
        }
      `}</style>

      <div className="bg-white rounded-lg shadow-lg border border-slate-200 p-4 mb-4 z-20 relative">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-slate-800 flex items-center">
             <MapIcon className="mr-2 text-blue-600" />
             Mapa de Cobertura y Direcciones
             {loadingData && <Loader2 className="ml-2 h-4 w-4 animate-spin text-slate-400" />}
          </h2>
        </div>
        
        <div className="flex flex-col gap-3">
            {/* ERROR/SUCCESS MESSAGES */}
            {searchError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 flex items-start gap-2">
                    <div className="text-red-600 mt-0.5">⚠️</div>
                    <div className="text-sm text-red-700 flex-1">{searchError}</div>
                    <button onClick={() => setSearchError(null)} className="text-red-400 hover:text-red-600">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}
            {searchSuccess && (
                <div className="bg-green-50 border border-green-200 rounded-md p-3 flex items-start gap-2">
                    <div className="text-green-600 mt-0.5">✓</div>
                    <div className="text-sm text-green-700 flex-1">{searchSuccess}</div>
                    <button onClick={() => setSearchSuccess(null)} className="text-green-400 hover:text-green-600">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}
            {/* SEARCH TABS */}
            <div className="flex flex-wrap gap-2 bg-slate-100 p-1 rounded-lg self-start">
                 <button 
                   onClick={() => setSearchMode('address')}
                   className={`flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                     searchMode === 'address' ? 'bg-white text-green-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                   }`}
                 >
                   <Navigation className="w-3 h-3 mr-1.5" />
                   Dirección
                 </button>
                 <button 
                   onClick={() => setSearchMode('cp')}
                   className={`flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                     searchMode === 'cp' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                   }`}
                 >
                   <Hash className="w-3 h-3 mr-1.5" />
                   Código Postal
                 </button>
                 <button 
                   onClick={() => setSearchMode('muni')}
                   className={`flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                     searchMode === 'muni' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                   }`}
                 >
                   <Building2 className="w-3 h-3 mr-1.5" />
                   Municipio
                 </button>
                 <button 
                   onClick={() => setSearchMode('depto')}
                   className={`flex items-center px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                     searchMode === 'depto' ? 'bg-white text-orange-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                   }`}
                 >
                   <Globe className="w-3 h-3 mr-1.5" />
                   Departamento
                 </button>
            </div>

            {/* SEARCH INPUT */}
            <div className="relative w-full flex items-center gap-2">
                 <div className="relative flex-1">
                     <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                         {loadingSearch ? <Loader2 className="h-4 w-4 animate-spin text-blue-500" /> : <Search className="h-4 w-4 text-slate-400" />}
                     </div>
                     <input 
                        type="text" 
                        className="block w-full pl-10 pr-10 py-2 border border-slate-300 rounded-md sm:text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-slate-400 h-10" 
                        placeholder={
                            searchMode === 'address' ? "Escriba la dirección (ej: Calle 59C 2C-76, Cali)" :
                            searchMode === 'cp' ? "Escriba el código postal (ej: 110111)..." :
                            searchMode === 'muni' ? "Escriba el municipio (Búsqueda Exacta)..." :
                            "Escriba el departamento (Búsqueda Exacta)..."
                        }
                        value={searchTerm} 
                        onChange={(e) => setSearchTerm(e.target.value)}
                        onKeyDown={handleKeyDown}
                     />
                     {searchTerm && <button onClick={() => setSearchTerm('')} className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>}
                 </div>

                 {/* ENABLED SEARCH BUTTON FOR ALL MODES */}
                 <button 
                    onClick={handleManualSearch}
                    disabled={loadingSearch || !searchTerm.trim()}
                    className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed h-10 flex items-center shadow-sm"
                 >
                    Buscar
                 </button>
            </div>
            
            <p className="text-[10px] text-slate-500 italic ml-1">
                {searchMode === 'address' && "Busca la coordenada exacta de una dirección en Google Maps y verifica su zona."}
                {searchMode === 'muni' && "Muestra todos los polígonos del municipio con sus códigos postales en pantalla."}
                {searchMode === 'depto' && "Muestra todas las zonas postales del departamento seleccionado."}
                {searchMode === 'cp' && "Localiza la ubicación y forma de un código postal específico."}
            </p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 flex-1 overflow-hidden relative z-0">
        <div ref={mapContainerRef} className="absolute inset-0 z-0 bg-slate-100" />
      </div>
    </div>
  );
};

export default MapView;
declare module 'shpjs' {
  export default function shp(input: ArrayBuffer | string): Promise<any>;
}
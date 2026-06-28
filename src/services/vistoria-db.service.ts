import { Injectable } from '@angular/core';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Vistoria } from '../components/checklist-inspecao/checklist-inspecao.component';

interface Predial4DB extends DBSchema {
  vistorias: {
    key: string;      // Vistoria.id
    value: Vistoria;
  };
}

const DB_NAME = 'predial4-db';
const DB_VERSION = 1;

@Injectable({ providedIn: 'root' })
export class VistoriaDbService {
  private dbPromise: Promise<IDBPDatabase<Predial4DB>>;

  constructor() {
    this.dbPromise = openDB<Predial4DB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Estrutura preparada para versões futuras (ex.: store 'evidencias' p/ fotos na v2)
        if (oldVersion < 1) {
          db.createObjectStore('vistorias', { keyPath: 'id' });
        }
      },
    });
  }

  async getAllVistorias(): Promise<Vistoria[]> {
    const db = await this.dbPromise;
    return db.getAll('vistorias');
  }

  async saveAllVistorias(lista: Vistoria[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('vistorias', 'readwrite');
    await Promise.all([...lista.map((v) => tx.store.put(v)), tx.done]);
  }

  async deleteVistoria(id: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete('vistorias', id);
  }

  async count(): Promise<number> {
    const db = await this.dbPromise;
    return db.count('vistorias');
  }

  /** Migração única: copia o que existir no localStorage para o IndexedDB, uma vez. */
  async migrarDoLocalStorageSeNecessario(): Promise<void> {
    const jaTem = await this.count();
    if (jaTem > 0) return;                       // IndexedDB já tem dados: nada a migrar
    const saved = localStorage.getItem('predial_vistorias');
    if (!saved) return;                          // não há dado antigo
    try {
      const parsed = JSON.parse(saved) as Vistoria[];
      if (Array.isArray(parsed) && parsed.length) {
        await this.saveAllVistorias(parsed);
        const conferido = await this.count();
        if (conferido >= parsed.length) {
          localStorage.removeItem('predial_vistorias'); // só remove APÓS confirmar a gravação
        }
      }
    } catch (e) {
      console.error('Falha ao migrar vistorias do localStorage para IndexedDB', e);
      // Em caso de erro, mantém o localStorage intacto (sem perda de dado).
    }
  }
}

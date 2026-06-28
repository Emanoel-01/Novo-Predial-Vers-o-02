import { Component, ChangeDetectionStrategy, signal, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataService } from '../../services/data.service';
import { ToastService } from '../../services/toast.service';
import { UserProfile } from '../../models/user-profile.model';
import { registroValido, generateStandardFooter, GeminiService } from '../../services/gemini.service';
import { VistoriaDbService, Evidencia } from '../../services/vistoria-db.service';
import { CameraService } from '../../services/camera.service';
import { Type } from '@google/genai';

export interface ChecklistItem {
  id: string;
  systemTitle: string;
  typologyTitle: string;
  title: string;
  description: string;
  status: 'PENDENTE' | 'PASS' | 'FAIL' | 'NA' | 'CONFORME' | 'NAO_CONFORME' | 'NAO_APLICAVEL';
  severity?: 'Mínimo' | 'Regular' | 'Crítico';
  notes: string;
  id_evidencias?: string[];   // chaves das fotos no store 'evidencias'
  diagnostico_ia?: string;    // texto do diagnóstico gerado pela IA
}

export interface Vistoria {
  id: string;
  buildingName: string;
  address: string;
  dateCreated: string;
  dateUpdated: string;
  progress: number;
  items: ChecklistItem[];
}

const SCHEMA_ANALISE_EVIDENCIA = {
  type: Type.OBJECT,
  properties: {
    texto: { type: Type.STRING },
    severitySugerida: { type: Type.STRING, enum: ['Mínimo', 'Regular', 'Crítico'] },
  },
  required: ['texto', 'severitySugerida'],
};

@Component({
  selector: 'app-checklist-inspecao',
  templateUrl: './checklist-inspecao.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class ChecklistInspecaoComponent implements OnInit {
  private dataService = inject(DataService);
  private toastService = inject(ToastService);
  private dbService = inject(VistoriaDbService);
  private camera = inject(CameraService);
  private geminiService = inject(GeminiService);

  // Controle de carregamento das vistorias
  carregandoVistorias = signal(true);

  // Perfil do profissional (pode vir local ou via input, vamos carregar do localStorage ou usar padrão)
  userProfile = signal<UserProfile | null>(null);

  // Vistorias salvas
  vistorias = signal<Vistoria[]>([]);
  vistoriaAtiva = signal<Vistoria | null>(null);
  vistoriaParaExcluir = signal<Vistoria | null>(null);

  // Estado para captura de evidência e IA
  itemCapturandoEvidencia = signal<ChecklistItem | null>(null);
  streamCamera = signal<MediaStream | null>(null);
  tipoEvidencia = signal<'contexto' | 'detalhe'>('contexto');
  capturando = signal(false);
  analisandoIa = signal(false);
  cameraIndisponivel = signal(false);
  dragOver = signal(false);
  itemSalvoFeedback = signal<string | null>(null);

  private sinalizarSalvo(itemId: string): void {
    this.itemSalvoFeedback.set(itemId);
    setTimeout(() => {
      if (this.itemSalvoFeedback() === itemId) {
        this.itemSalvoFeedback.set(null);
      }
    }, 2000);
  }

  // Estado do formulário de criação
  novoBuildingName = signal('');
  novoAddress = signal('');
  selecaoSistemas = signal<{ [key: string]: boolean }>({}); // chave: "systemKey-typologyTitle"

  // Filtros de visualização
  filtroStatus = signal<'TODOS' | 'PENDENTE' | 'PASS' | 'FAIL' | 'NA'>('TODOS');
  filtroSistema = signal<string>('TODOS');

  // Modo de visualização: 'LISTA' (gerenciar vistorias) ou 'EXECUCAO' (inspecionando no local) ou 'CRIACAO' (configurando nova)
  modoExibicao = signal<'LISTA' | 'CRIACAO' | 'EXECUCAO'>('LISTA');

  // Carregar os sistemas organizados da base de dados estática
  sistemasDisponiveis = computed(() => {
    const data = this.dataService.getData();
    return Object.entries(data).map(([catKey, catVal]: [string, any]) => ({
      key: catKey,
      title: catVal.title,
      subSystems: Object.entries(catVal.systems).map(([sysKey, sysVal]: [string, any]) => ({
        key: sysKey,
        title: sysVal.title,
        icon: sysVal.icon || '📋',
        typologies: sysVal.tipologias.map((t: any) => {
          // Achar patologias relacionadas a essa tipologia
          const patologiasRelacionadas = (sysVal.patologias || []).filter(
            (p: any) => p.typology_link === t.title
          );
          return {
            title: t.title,
            definicao: t.definicao,
            patologiasCount: patologiasRelacionadas.length,
            patologias: patologiasRelacionadas,
          };
        }),
      })),
    }));
  });

  // Filtro de sistemas na execução do checklist
  sistemasNoChecklistAtivo = computed(() => {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return [];
    const nomes = new Set<string>();
    ativa.items.forEach(item => nomes.add(item.systemTitle));
    return Array.from(nomes);
  });

  // Itens filtrados para exibição
  itemsExibidos = computed(() => {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return [];

    const fStatus = this.filtroStatus();
    const fSistema = this.filtroSistema();

    return ativa.items.filter(item => {
      const matchSistema = fSistema === 'TODOS' || item.systemTitle === fSistema;
      
      let matchStatus = true;
      const currentStatus = item.status === 'CONFORME' ? 'PASS' : 
                            item.status === 'NAO_CONFORME' ? 'FAIL' : 
                            item.status === 'NAO_APLICAVEL' ? 'NA' : item.status;

      if (fStatus === 'PENDENTE') matchStatus = currentStatus === 'PENDENTE';
      else if (fStatus === 'PASS') matchStatus = currentStatus === 'PASS';
      else if (fStatus === 'FAIL') matchStatus = currentStatus === 'FAIL';
      else if (fStatus === 'NA') matchStatus = currentStatus === 'NA';

      return matchSistema && matchStatus;
    });
  });

  // Estatísticas de conformidade da vistoria ativa
  estatisticasAtivas = computed(() => {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return { total: 0, avaliados: 0, conformes: 0, naoConformes: 0, naoAplicaveis: 0, pendentes: 0, percentualConclusao: 0, taxaConformidade: 0 };

    const total = ativa.items.length;
    const conformes = ativa.items.filter(i => i.status === 'PASS' || i.status === 'CONFORME').length;
    const naoConformes = ativa.items.filter(i => i.status === 'FAIL' || i.status === 'NAO_CONFORME').length;
    const naoAplicaveis = ativa.items.filter(i => i.status === 'NA' || i.status === 'NAO_APLICAVEL').length;
    const pendentes = ativa.items.filter(i => i.status === 'PENDENTE').length;
    const avaliados = total - pendentes;

    const percentualConclusao = total > 0 ? Math.round((avaliados / total) * 100) : 0;
    const avaliadosComStatusReal = conformes + naoConformes;
    const taxaConformidade = avaliadosComStatusReal > 0 ? Math.round((conformes / avaliadosComStatusReal) * 100) : 0;

    return {
      total,
      avaliados,
      conformes,
      naoConformes,
      naoAplicaveis,
      pendentes,
      percentualConclusao,
      taxaConformidade
    };
  });

  ngOnInit(): void {
    void this.carregarVistorias();
    this.carregarPerfilDoLocalStorage();
  }

  carregarPerfilDoLocalStorage(): void {
    try {
      const saved = localStorage.getItem('user_profile');
      if (saved) {
        this.userProfile.set(JSON.parse(saved));
      } else {
        // Usar padrão caso não ache
        this.userProfile.set({
          fullName: 'Emanoel Amorim',
          professionalTitle: 'Arquiteto e Urbanista',
          professionalId: 'CAU-PE 123456',
          companyName: 'AmorimTech',
          position: 'Diretor de Engenharia',
          companyCnpj: '12.345.678/0001-90',
          companyAddress: 'Recife - PE, Brasil',
        });
      }
    } catch (e) {
      console.error('Erro ao carregar perfil do localStorage', e);
    }
  }

  async carregarVistorias(): Promise<void> {
    this.carregandoVistorias.set(true);
    try {
      await this.dbService.migrarDoLocalStorageSeNecessario();
      const lista = await this.dbService.getAllVistorias();
      // Mapear severidades antigas para o padrão canônico NBR 16747
      lista.forEach(v => {
        if (v.items) {
          v.items.forEach(item => {
            if (item.severity) {
              const s = String(item.severity).toUpperCase();
              if (s === 'MÍNIMA' || s === 'MINIMA') item.severity = 'Mínimo';
              else if (s === 'MÉDIA' || s === 'MEDIA') item.severity = 'Regular';
              else if (s === 'GRAVE') item.severity = 'Crítico';
            }
          });
        }
      });
      // Ordenar por última atualização
      lista.sort((a, b) => new Date(b.dateUpdated).getTime() - new Date(a.dateUpdated).getTime());
      this.vistorias.set(lista);
    } catch (e) {
      console.error('Erro ao carregar vistorias do IndexedDB', e);
      this.toastService.show('Não foi possível carregar as vistorias salvas.', 'error');
    } finally {
      this.carregandoVistorias.set(false);
    }
  }

  async salvarVistorias(lista: Vistoria[]): Promise<void> {
    try {
      await this.dbService.saveAllVistorias(lista);
      this.vistorias.set(lista);
    } catch (e) {
      console.error('Erro ao salvar vistorias no IndexedDB', e);
      this.toastService.show('Erro ao salvar o progresso no IndexedDB.', 'error');
    }
  }

  private notesSaveTimer: any = null;
  private persistirComDebounce(lista: Vistoria[]): void {
    if (this.notesSaveTimer) clearTimeout(this.notesSaveTimer);
    this.notesSaveTimer = setTimeout(() => { void this.salvarVistorias(lista); }, 500);
  }

  abrirCriacao(): void {
    this.novoBuildingName.set('');
    this.novoAddress.set('');
    this.selecaoSistemas.set({});
    this.modoExibicao.set('CRIACAO');
  }

  cancelarCriacao(): void {
    this.modoExibicao.set('LISTA');
  }

  toggleTypologySelecao(systemKey: string, typologyTitle: string): void {
    const key = `${systemKey}-${typologyTitle}`;
    this.selecaoSistemas.update(current => {
      const next = { ...current };
      next[key] = !next[key];
      return next;
    });
  }

  selecionarTodosSistemas(): void {
    const data = this.dataService.getData();
    const nextSelection: { [key: string]: boolean } = {};
    
    Object.entries(data).forEach(([catKey, catVal]: [string, any]) => {
      Object.entries(catVal.systems).forEach(([sysKey, sysVal]: [string, any]) => {
        sysVal.tipologias.forEach((t: any) => {
          nextSelection[`${sysKey}-${t.title}`] = true;
        });
      });
    });

    this.selecaoSistemas.set(nextSelection);
    this.toastService.show('Todas as tipologias de sistemas foram selecionadas!', 'success');
  }

  limparSelecaoSistemas(): void {
    this.selecaoSistemas.set({});
    this.toastService.show('Seleção limpa com sucesso.', 'info');
  }

  criarVistoria(): void {
    const name = this.novoBuildingName().trim();
    const address = this.novoAddress().trim();

    if (!name || !address) {
      this.toastService.show('Por favor, preencha o Nome do Edifício e o Endereço.', 'error');
      return;
    }

    // Coletar tipologias selecionadas
    const selecionados = Object.entries(this.selecaoSistemas()).filter(([_, val]) => val).map(([key, _]) => key);
    if (selecionados.length === 0) {
      this.toastService.show('Por favor, selecione ao menos uma tipologia para inspecionar.', 'error');
      return;
    }

    const items: ChecklistItem[] = [];
    const data = this.dataService.getData();

    // Mapear os dados para gerar os itens técnicos estruturados
    Object.entries(data).forEach(([catKey, catVal]: [string, any]) => {
      Object.entries(catVal.systems).forEach(([sysKey, sysVal]: [string, any]) => {
        sysVal.tipologias.forEach((t: any) => {
          const selectionKey = `${sysKey}-${t.title}`;
          if (this.selecaoSistemas()[selectionKey]) {
            // 1. Criar item básico de integridade geral para essa tipologia
            items.push({
              id: `${sysKey}-${t.title.replace(/\s+/g, '_')}-geral`,
              systemTitle: sysVal.title,
              typologyTitle: t.title,
              title: `Inspeção Geral de Integridade`,
              description: `Realizar varredura visual em busca de deformações, anomalias de acabamento ou fissuras superficiais na tecnologia: ${t.title}.`,
              status: 'PENDENTE',
              notes: ''
            });

            // 2. Criar itens específicos para cada patologia cadastrada nesta tipologia
            const patologiasRelacionadas = (sysVal.patologias || []).filter(
              (p: any) => p.typology_link === t.title
            );

            patologiasRelacionadas.forEach((p: any, idx: number) => {
              items.push({
                id: `${sysKey}-${t.title.replace(/\s+/g, '_')}-pat-${idx}`,
                systemTitle: sysVal.title,
                typologyTitle: t.title,
                title: `Investigar: ${p.title}`,
                description: `Avaliar se há ocorrência de ${p.title}. Sintomas de alerta: ${p.sintomas}. Causas prováveis na vistoria: ${p.causas}.`,
                status: 'PENDENTE',
                notes: ''
              });
            });
          }
        });
      });
    });

    const novaVistoria: Vistoria = {
      id: 'vistoria-' + Date.now(),
      buildingName: name,
      address: address,
      dateCreated: new Date().toISOString(),
      dateUpdated: new Date().toISOString(),
      progress: 0,
      items: items
    };

    const atualizadas = [novaVistoria, ...this.vistorias()];
    void this.salvarVistorias(atualizadas);
    this.vistoriaAtiva.set(novaVistoria);
    this.modoExibicao.set('EXECUCAO');
    this.filtroStatus.set('TODOS');
    this.filtroSistema.set('TODOS');
    this.toastService.show('Vistoria iniciada! Prancheta de campo gerada com sucesso.', 'success');
  }

  abrirVistoria(vistoria: Vistoria): void {
    // Carregar do array para garantir dados frescos
    const encontrada = this.vistorias().find(v => v.id === vistoria.id);
    if (encontrada) {
      this.vistoriaAtiva.set(encontrada);
      this.modoExibicao.set('EXECUCAO');
      this.filtroStatus.set('TODOS');
      this.filtroSistema.set('TODOS');
      this.toastService.show(`Retomando vistoria do ${encontrada.buildingName}`, 'info');
    }
  }

  excluirVistoria(event: Event, id: string): void {
    event.stopPropagation();
    const vistoria = this.vistorias().find(v => v.id === id);
    if (vistoria) {
      this.vistoriaParaExcluir.set(vistoria);
    }
  }

  cancelarExclusao(): void {
    this.vistoriaParaExcluir.set(null);
  }

  async confirmarExclusao(): Promise<void> {
    const alvo = this.vistoriaParaExcluir();
    if (!alvo) return;
    console.log('exclusão confirmada — removendo do IndexedDB', alvo.id);
    try {
      await this.dbService.deleteVistoria(alvo.id);            // 1) DB primeiro
    } catch (e) {
      console.error('Erro ao excluir vistoria do IndexedDB', e);
      this.toastService.show('Erro ao excluir vistoria do banco de dados.', 'error');
      return;                                                   // aborta sem mexer na lista
    }
    // 2) só após o sucesso, sincroniza memória/UI
    this.vistorias.set(this.vistorias().filter(v => v.id !== alvo.id));
    if (this.vistoriaAtiva()?.id === alvo.id) {
      this.vistoriaAtiva.set(null);
      this.modoExibicao.set('LISTA');
    }
    this.vistoriaParaExcluir.set(null);
    this.toastService.show('Vistoria excluída com sucesso.', 'success');
  }

  alterarStatusItem(itemId: string, novoStatus: 'PASS' | 'FAIL' | 'NA'): void {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return;

    const novosItens = ativa.items.map(item => {
      if (item.id === itemId) {
        const itemAtualizado = { ...item, status: novoStatus };
        // Resetar gravidade se mudou de falha (FAIL) para outra coisa
        if (novoStatus !== 'FAIL') {
          delete itemAtualizado.severity;
        } else if (!itemAtualizado.severity) {
          // Valor padrão para não conforme
          itemAtualizado.severity = 'Regular';
        }
        return itemAtualizado;
      }
      return item;
    });

    this.atualizarItensVistoriaAtiva(novosItens);
    this.sinalizarSalvo(itemId);
  }

  alterarGravidadeItem(itemId: string, novaGravidade: 'Mínimo' | 'Regular' | 'Crítico'): void {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return;

    const novosItens = ativa.items.map(item => {
      if (item.id === itemId && (item.status === 'FAIL' || item.status === 'NAO_CONFORME')) {
        return { ...item, severity: novaGravidade };
      }
      return item;
    });

    this.atualizarItensVistoriaAtiva(novosItens);
    this.sinalizarSalvo(itemId);
  }

  async abrirCaptura(item: ChecklistItem, tipo: 'contexto'|'detalhe'): Promise<void> {
    this.tipoEvidencia.set(tipo);
    this.itemCapturandoEvidencia.set(item);
    this.cameraIndisponivel.set(false);
    try {
      const stream = await this.camera.iniciar(true);
      this.streamCamera.set(stream);
    } catch (e) {
      console.error('Erro ao abrir câmera', e);
      this.cameraIndisponivel.set(true);
      this.toastService.show('Câmera indisponível. Utilize a seleção de arquivos para anexar a evidência.', 'info');
    }
  }

  fecharCaptura(): void {
    this.camera.parar();
    this.streamCamera.set(null);
    this.itemCapturandoEvidencia.set(null);
    this.capturando.set(false);
    this.analisandoIa.set(false);
    this.cameraIndisponivel.set(false);
    this.dragOver.set(false);
  }

  async processarArquivoSelecionado(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      this.toastService.show('Por favor, selecione um arquivo de imagem válido.', 'error');
      return;
    }

    const item = this.itemCapturandoEvidencia();
    if (!item) return;

    this.capturando.set(true);

    try {
      const blob = new Blob([file], { type: file.type });
      const geo = await this.camera.obterLocalizacao();
      const idEvidencia = crypto.randomUUID();

      const ev: Evidencia = {
        id: idEvidencia,
        blob,
        mimeType: file.type,
        tipo: this.tipoEvidencia(),
        geo,
        timestamp: new Date().toISOString(),
        id_item: item.id
      };

      await this.dbService.saveEvidencia(ev);

      const novas = [...(item.id_evidencias ?? []), idEvidencia];
      this.aplicarMudancaNoItem(item.id, it => ({ ...it, id_evidencias: novas }));

      this.capturando.set(false);
      this.analisandoIa.set(true);

      const base64 = await this.blobParaBase64(blob);
      const diag = await this.analisarComGemini(item, base64);

      if (diag?.texto) {
        this.aplicarMudancaNoItem(item.id, it => ({ ...it, diagnostico_ia: diag.texto }));
      }

      const itemAtualizado = this.vistoriaAtiva()?.items.find(it => it.id === item.id);
      if (diag?.severitySugerida && (!itemAtualizado || !itemAtualizado.severity)) {
        this.alterarGravidadeItem(item.id, diag.severitySugerida);
      }
    } catch (e) {
      console.error('Falha no processamento do arquivo/análise', e);
      this.toastService.show('Falha ao processar arquivo ou analisar evidência.', 'error');
    } finally {
      this.analisandoIa.set(false);
      this.fecharCaptura();
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void this.processarArquivoSelecionado(input.files[0]);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      void this.processarArquivoSelecionado(event.dataTransfer.files[0]);
    }
  }

  private aplicarMudancaNoItem(itemId: string, updater: (item: ChecklistItem) => ChecklistItem): void {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return;

    const novosItens = ativa.items.map(item => {
      if (item.id === itemId) {
        return updater(item);
      }
      return item;
    });

    this.atualizarItensVistoriaAtiva(novosItens, false);
    this.sinalizarSalvo(itemId);
  }

  private async blobParaBase64(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private async analisarComGemini(
    item: ChecklistItem,
    base64: string
  ): Promise<{ texto: string; severitySugerida?: 'Mínimo' | 'Regular' | 'Crítico' } | null> {
    try {
      const prompt = `Você é um engenheiro civil perito especializado em inspeção predial de acordo com a NBR 16747.
Analise a imagem de evidência fornecida para o seguinte item de checklist que apresentou não conformidade / falha:
- Sistema: ${item.systemTitle}
- Tipologia: ${item.typologyTitle}
- Item: ${item.title}
- Descrição detalhada: ${item.description}

Com base na imagem e no contexto do item falho, forneça:
1. Diagnóstico técnico detalhado e conciso explicando a causa provável e impacto da anomalia identificada.
2. O grau de risco sugerido conforme a NBR 16747 (deve ser estritamente 'Mínimo', 'Regular' ou 'Crítico').`;

      const textPart = { text: prompt };
      const imagePart = {
        inlineData: {
          data: base64,
          mimeType: 'image/jpeg',
        },
      };
      const contents = { parts: [textPart, imagePart] };

      const result = await this.geminiService.generateStructured<{
        texto: string;
        severitySugerida: 'Mínimo' | 'Regular' | 'Crítico';
      }>(contents, SCHEMA_ANALISE_EVIDENCIA);

      return {
        texto: result.texto,
        severitySugerida: result.severitySugerida,
      };
    } catch (e) {
      console.error('Erro na chamada do Gemini:', e);
      return null;
    }
  }

  async capturarEAnalisar(): Promise<void> {
    const item = this.itemCapturandoEvidencia();
    if (!item) return;
    this.capturando.set(true);

    try {
      const blob = await this.camera.capturarBlob();
      const geo = await this.camera.obterLocalizacao();
      const idEvidencia = crypto.randomUUID();

      const ev: Evidencia = {
        id: idEvidencia,
        blob,
        mimeType: 'image/jpeg',
        tipo: this.tipoEvidencia(),
        geo,
        timestamp: new Date().toISOString(),
        id_item: item.id
      };

      await this.dbService.saveEvidencia(ev);

      const novas = [...(item.id_evidencias ?? []), idEvidencia];
      this.aplicarMudancaNoItem(item.id, it => ({ ...it, id_evidencias: novas }));

      this.capturando.set(false);
      this.analisandoIa.set(true);

      const base64 = await this.blobParaBase64(blob);
      const diag = await this.analisarComGemini(item, base64);

      if (diag?.texto) {
        this.aplicarMudancaNoItem(item.id, it => ({ ...it, diagnostico_ia: diag.texto }));
      }

      const itemAtualizado = this.vistoriaAtiva()?.items.find(it => it.id === item.id);
      if (diag?.severitySugerida && (!itemAtualizado || !itemAtualizado.severity)) {
        this.alterarGravidadeItem(item.id, diag.severitySugerida);
      }
    } catch (e) {
      console.error('Falha na captura/análise de evidência', e);
      this.toastService.show('Falha ao capturar ou analisar a evidência.', 'error');
    } finally {
      this.analisandoIa.set(false);
      this.fecharCaptura();
    }
  }

  atualizarNotasItem(itemId: string, event: Event): void {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return;

    const valor = ((event.target as HTMLInputElement).value || '').trim();

    const novosItens = ativa.items.map(item => {
      if (item.id === itemId) {
        return { ...item, notes: valor };
      }
      return item;
    });

    this.atualizarItensVistoriaAtiva(novosItens, true);
  }

  private atualizarItensVistoriaAtiva(itens: ChecklistItem[], isNotes: boolean = false): void {
    const ativa = this.vistoriaAtiva();
    if (!ativa) return;

    const total = itens.length;
    const avaliados = itens.filter(i => i.status !== 'PENDENTE').length;
    const progress = total > 0 ? Math.round((avaliados / total) * 100) : 0;

    const vistoriaAtualizada: Vistoria = {
      ...ativa,
      items: itens,
      progress: progress,
      dateUpdated: new Date().toISOString()
    };

    this.vistoriaAtiva.set(vistoriaAtualizada);

    // Salvar na lista completa
    const listaAtualizada = this.vistorias().map(v => {
      if (v.id === ativa.id) {
        return vistoriaAtualizada;
      }
      return v;
    });

    if (isNotes) {
      this.vistorias.set(listaAtualizada);
      this.persistirComDebounce(listaAtualizada);
    } else {
      void this.salvarVistorias(listaAtualizada);
    }
  }

  voltarParaLista(): void {
    this.vistoriaAtiva.set(null);
    this.modoExibicao.set('LISTA');
    void this.carregarVistorias(); // Recarregar e ordenar
  }

  exportarRelatorioPDF(): void {
    const ativa = this.vistoriaAtiva();
    const profile = this.userProfile();
    if (!profile || !registroValido(profile.professionalId)) {
      this.toastService.show('Emissão bloqueada. É necessário possuir um registro profissional (CAU/CREA) válido cadastrado no seu perfil para emitir documentos técnicos.', 'error');
      return;
    }
    if (!ativa) {
      this.toastService.show('Dados insuficientes para gerar o relatório em PDF.', 'error');
      return;
    }

    const estatisticas = this.estatisticasAtivas();
    const form = { buildingName: ativa.buildingName, address: ativa.address };
    
    // Organizar itens por Sistema para renderização limpa
    const itensPorSistema: { [sistema: string]: ChecklistItem[] } = {};
    ativa.items.forEach(item => {
      if (!itensPorSistema[item.systemTitle]) {
        itensPorSistema[item.systemTitle] = [];
      }
      itensPorSistema[item.systemTitle].push(item);
    });

    let itemsHtml = '';
    Object.entries(itensPorSistema).forEach(([sistema, itens]) => {
      itemsHtml += `
        <tr>
          <th colspan="4" class="system-header-row">${sistema}</th>
        </tr>
      `;
      itens.forEach(item => {
        let statusBadge = '';
        if (item.status === 'PASS' || item.status === 'CONFORME') {
          statusBadge = '<span class="badge badge-success">PASS (Aprovado)</span>';
        } else if (item.status === 'FAIL' || item.status === 'NAO_CONFORME') {
          statusBadge = `<span class="badge badge-danger">FAIL (Falha - ${item.severity || 'Regular'})</span>`;
        } else if (item.status === 'NA' || item.status === 'NAO_APLICAVEL') {
          statusBadge = '<span class="badge badge-gray">N/A (Não Aplicável)</span>';
        } else {
          statusBadge = '<span class="badge badge-pending">PENDENTE</span>';
        }

        itemsHtml += `
          <tr>
            <td style="font-size: 0.85em;"><strong>${item.typologyTitle}</strong><br><span style="color: #666;">${item.title}</span></td>
            <td style="font-size: 0.8em; color: #555;">${item.description}</td>
            <td style="text-align: center;">${statusBadge}</td>
            <td style="font-size: 0.8em; max-width: 150px; word-wrap: break-word;">${item.notes || '<em>Nenhuma anotação.</em>'}</td>
          </tr>
        `;
      });
    });

    let companyInfo = '';
    if (profile.companyName) {
      companyInfo += `<p>${profile.companyName}${profile.position ? ` - ${profile.position}` : ''}</p>`;
      if (profile.companyCnpj) companyInfo += `<p>CNPJ: ${profile.companyCnpj}</p>`;
      if (profile.companyAddress) companyInfo += `<p>${profile.companyAddress}</p>`;
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
          <meta charset="utf-8">
          <title>Relatório de Vistoria de Campo - ${form.buildingName}</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 40px; color: #333; line-height: 1.5; font-size: 10pt; }
              .header { text-align: center; margin-bottom: 30px; border-bottom: 3px solid #0c4a6e; padding-bottom: 20px; }
              .header h1 { color: #0c4a6e; margin: 0; font-size: 1.8em; font-weight: bold; }
              .header p { color: #555; margin: 5px 0; font-size: 1.1em; }
              
              .stats-container { display: flex; justify-content: space-between; gap: 15px; margin-bottom: 25px; }
              .stat-box { flex: 1; border: 1px solid #e2e8f0; padding: 10px; border-radius: 6px; text-align: center; background-color: #f8fafc; }
              .stat-box .num { font-size: 1.5em; font-weight: bold; color: #0c4a6e; margin-bottom: 2px; }
              .stat-box .lbl { font-size: 0.75em; text-transform: uppercase; color: #64748b; font-weight: 600; }
              
              .info-table { width: 100%; border-collapse: collapse; margin-bottom: 25px; }
              .info-table td { border: 1px solid #e2e8f0; padding: 8px; vertical-align: middle; }
              .info-table td.label { font-weight: bold; background-color: #f1f5f9; width: 22%; color: #1e293b; }
              
              h2 { color: #0c4a6e; margin-top: 25px; margin-bottom: 10px; border-bottom: 1.5px solid #0c4a6e; padding-bottom: 5px; font-size: 1.3em; }
              
              .checklist-table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 0.85em; }
              .checklist-table tr { page-break-inside: avoid; }
              .checklist-table thead { display: table-header-group; }
              .checklist-table th, .checklist-table td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; }
              .checklist-table thead th { background-color: #0c4a6e; color: white; font-weight: bold; font-size: 0.95em; }
              
              .system-header-row { background-color: #e2e8f0 !important; color: #0f172a !important; text-align: left; font-weight: bold !important; font-size: 1.05em !important; padding: 8px 12px !important; }
              .checklist-table tbody tr:nth-child(even):not(:has(.system-header-row)) { background-color: #f8fafc; }
              
              .badge { display: inline-block; padding: 3px 6px; font-size: 0.75em; font-weight: bold; border-radius: 4px; text-align: center; white-space: nowrap; }
              .badge-success { background-color: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
              .badge-danger { background-color: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }
              .badge-gray { background-color: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
              .badge-pending { background-color: #fef3c7; color: #b45309; border: 1px solid #fde68a; }

              .disclaimer { background-color: #fef3c7; padding: 12px; border-radius: 6px; margin-top: 30px; border-left: 4px solid #f59e0b; font-size: 0.85em; }
              @media print { body { margin: 20px; font-size: 9pt; } }
          </style>
      </head>
      <body>
          <div class="header">
            <h1>Relatório Técnico de Inspeção e Vistoria Predial</h1>
            <p>Laudo de Campo Interativo - Predial 4.0</p>
          </div>
          
          <h2>Informações da Vistoria</h2>
          <table class="info-table">
            <tr>
              <td class="label">Edifício</td>
              <td><strong>${form.buildingName}</strong></td>
              <td class="label">Data de Início</td>
              <td>${new Date(ativa.dateCreated).toLocaleDateString('pt-BR')}</td>
            </tr>
            <tr>
              <td class="label">Endereço</td>
              <td>${form.address}</td>
              <td class="label">Última Atualização</td>
              <td>${new Date(ativa.dateUpdated).toLocaleString('pt-BR')}</td>
            </tr>
          </table>

          <h2>Resumo de Campo e Desempenho</h2>
          <div class="stats-container">
            <div class="stat-box">
              <div class="num">${estatisticas.total}</div>
              <div class="lbl">Itens Totais</div>
            </div>
            <div class="stat-box">
              <div class="num">${estatisticas.avaliados}</div>
              <div class="lbl">Inspecionados</div>
            </div>
            <div class="stat-box" style="background-color: #ecfdf5;">
              <div class="num" style="color: #059669;">${estatisticas.conformes}</div>
              <div class="lbl" style="color: #047857;">Conformes (OK)</div>
            </div>
            <div class="stat-box" style="background-color: #fef2f2;">
              <div class="num" style="color: #dc2626;">${estatisticas.naoConformes}</div>
              <div class="lbl" style="color: #b91c1c;">Inconformidades (NC)</div>
            </div>
            <div class="stat-box">
              <div class="num">${estatisticas.percentualConclusao}%</div>
              <div class="lbl">Conclusão</div>
            </div>
            <div class="stat-box" style="background-color: #f0fdf4;">
              <div class="num" style="color: #16a34a;">${estatisticas.taxaConformidade}%</div>
              <div class="lbl">Conformidade</div>
            </div>
          </div>

          <h2>Detalhamento do Checklist por Sistema</h2>
          <table class="checklist-table">
            <thead>
              <tr>
                <th style="width: 25%;">Tipologia / Item</th>
                <th style="width: 35%;">Procedimento e Critério de Inspeção</th>
                <th style="width: 18%; text-align: center;">Status de Campo</th>
                <th style="width: 22%;">Anotações / Evidências</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>

          <div class="disclaimer">
            <p><strong>Responsabilidade e Limites:</strong> As informações anotadas correspondem aos achados de campo no momento da inspeção. Este documento constitui um rascunho técnico de auxílio e sua validação técnica oficial está condicionada à assinatura do profissional habilitado com o respectivo registro de responsabilidade técnica (ART/RRT).</p>
          </div>

          ${generateStandardFooter(profile)}
      </body>
      </html>
    `;

    const newWindow = window.open('', '_blank');
    if (newWindow) {
      newWindow.document.write(htmlContent);
      newWindow.document.close();
      setTimeout(() => newWindow.print(), 500);
    } else {
      this.toastService.show('Não foi possível abrir o relatório em PDF. Permita popups neste site.', 'error');
    }
  }
}

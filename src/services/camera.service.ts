import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class CameraService {
  private stream: MediaStream | null = null;

  /**
   * Liga a câmera priorizando a traseira; guarda o stream internamente
   * e retorna o stream para que a UI possa usá-lo se necessário.
   */
  async iniciar(preferirTraseira = true): Promise<MediaStream> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('Câmera indisponível ou permissão negada');
    }

    // Se já houver um stream ativo, para antes de iniciar
    this.parar();

    const constraints: MediaStreamConstraints = {
      video: preferirTraseira
        ? { facingMode: { ideal: 'environment' } }
        : { facingMode: 'user' },
      audio: false
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      return this.stream;
    } catch (error) {
      console.warn('Falha ao iniciar câmera traseira ideal. Tentando fallback para qualquer câmera...', error);
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        return this.stream;
      } catch (fallbackError) {
        console.error('Falha geral ao iniciar câmera:', fallbackError);
        throw new Error('Câmera indisponível ou permissão negada');
      }
    }
  }

  /**
   * Desliga a câmera: para todas as tracks e limpa o stream interno.
   */
  parar(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop();
      });
      this.stream = null;
    }
  }

  /**
   * Captura um frame a partir do próprio stream interno (não recebe <video>).
   * Cria um <video> temporário em memória ligado ao stream interno,
   * aguarda a reprodução de um frame, pinta num canvas em memória
   * e resolve em um Blob JPEG com qualidade 0.85.
   */
  async capturarBlob(): Promise<Blob> {
    if (!this.stream) {
      throw new Error('Câmera não iniciada');
    }

    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.playsInline = true;
    video.muted = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play()
          .then(() => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              resolve();
            } else {
              video.onplaying = () => resolve();
            }
          })
          .catch(reject);
      };
      video.onerror = (err) => reject(new Error('Erro no carregamento do vídeo para captura'));
      
      // Timeout de segurança
      setTimeout(() => reject(new Error('Timeout ao aguardar reprodução do vídeo em memória')), 5000);
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Não foi possível obter o contexto 2D do canvas em memória');
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Limpa referências do vídeo temporário
    video.srcObject = null;
    video.load();

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Falha ao gerar o Blob da imagem capturada'));
          }
        },
        'image/jpeg',
        0.85
      );
    });
  }

  /**
   * Coordenada atual do GPS; retorna null em caso de erro ou permissão negada (nunca lança erro).
   */
  async obterLocalizacao(): Promise<{ lat: number; lng: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return null;
    }

    return new Promise<{ lat: number; lng: number } | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude
          });
        },
        (error) => {
          console.warn('Erro ao obter localização via GPS:', error);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 0
        }
      );
    });
  }
}

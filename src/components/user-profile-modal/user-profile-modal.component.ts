import { Component, ChangeDetectionStrategy, input, output, inject, signal, effect } from '@angular/core';
import { UserProfile } from '../../models/user-profile.model';
import { FormsModule } from '@angular/forms';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-user-profile-modal',
  templateUrl: './user-profile-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
})
export class UserProfileModalComponent {
  isOpen = input.required<boolean>();
  closeModal = output<void>();
  profileUpdate = output<UserProfile>();
  logout = output<void>();
  profileData = input<UserProfile | null>(null);

  private toastService = inject(ToastService);

  profile: UserProfile = {
    fullName: 'Emanoel Amorim',
    professionalTitle: 'Arquiteto e Urbanista',
    professionalId: 'CAU-PE 123456',
    companyName: 'AmorimTech',
    position: 'Diretor de Engenharia',
    companyCnpj: '12.345.678/0001-90',
    companyAddress: 'Recife - PE, Brasil',
  };

  saveState = signal<'idle' | 'saving' | 'saved'>('idle');

  constructor() {
    effect(() => {
      const data = this.profileData();
      if (data) {
        this.profile = { ...data };
      } else {
        const saved = localStorage.getItem('user_profile');
        if (saved) {
          try {
            this.profile = JSON.parse(saved);
          } catch {}
        }
      }
    });
  }

  onClose(): void {
    this.saveState.set('idle');
    this.closeModal.emit();
  }

  saveProfile(): void {
    if (this.saveState() !== 'idle') return;

    this.saveState.set('saving');

    // In a real app, this would be an async operation
    setTimeout(() => {
      this.profileUpdate.emit(this.profile);
      this.saveState.set('saved');
      this.toastService.show('Perfil atualizado com sucesso!', 'success');
      
      setTimeout(() => {
        this.onClose();
      }, 1500); // Wait in "saved" state before closing
    }, 500); // Simulate API call
  }

  onLogout(): void {
    this.logout.emit();
  }
}

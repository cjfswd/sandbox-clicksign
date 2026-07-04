import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('./native/session', () => ({
  startSession: vi.fn(),
}));

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    path: '/tmp/doc.pdf',
    filename: 'doc.pdf',
    bytes: new Uint8Array(),
    name: '',
    email: '',
    phone: '',
    delivery: 'link',
    deadlineAt: '',
    status: 'idle',
    signUrl: null,
    errorMessage: null,
    actionError: null,
    itemId: null,
    ...overrides,
  };
}

describe('App.vue', () => {
  it('renders the delivery labels select for each draft', async () => {
    const wrapper = mount(App);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapper.vm as any).drafts.push(makeDraft());
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Assinatura manuscrita (sem token)');
  });

  it('onBatchDeadlineChange propagates batch deadline to all drafts', async () => {
    const wrapper = mount(App);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = wrapper.vm as any;
    vm.drafts.push(makeDraft({ deadlineAt: '' }));
    vm.drafts.push(makeDraft({ deadlineAt: '' }));
    await wrapper.vm.$nextTick();

    vm.batchDeadline = '2026-08-01';
    vm.onBatchDeadlineChange();
    await wrapper.vm.$nextTick();

    expect(vm.drafts[0].deadlineAt).toBe('2026-08-01');
    expect(vm.drafts[1].deadlineAt).toBe('2026-08-01');
  });

  it('disables the "Enviar lote" button while sending is true', async () => {
    const wrapper = mount(App);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vm = wrapper.vm as any;

    const button = wrapper.find('button.bg-emerald-600');
    expect(button.exists()).toBe(true);
    expect(button.attributes('disabled')).toBeUndefined();

    vm.sending = true;
    await wrapper.vm.$nextTick();

    expect(wrapper.find('button.bg-emerald-600').attributes('disabled')).not.toBeUndefined();
  });
});

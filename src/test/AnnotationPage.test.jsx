import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnnotationPage from '../pages/AnnotationPage';

vi.mock('../components/AppChrome', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

const session = {
  session_token: 'session-token',
  team: {
    id: 'team-1',
    name: 'Team One',
  },
};

describe('AnnotationPage label selection', () => {
  beforeEach(() => {
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };

    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      drawImage: vi.fn(),
    }));
  });

  it('does not highlight a digit before the student chooses a label', () => {
    const view = render(<AnnotationPage session={session} />);

    expect(view.container.querySelector('.digit-button-active')).toBeNull();
  });

  it('asks the student to write before choosing a label on an empty canvas', () => {
    const view = render(<AnnotationPage session={session} />);

    fireEvent.click(view.getByRole('button', { name: '4' }));

    expect(view.container.querySelector('.digit-button-active')).toBeNull();
    expect(view.getByText('请先在画布上写数字，再选择标签上传。')).toBeInTheDocument();
  });
});

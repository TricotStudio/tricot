// A website shown on the board can't take the board down with it: whatever
// goes wrong drawing its card or its full view stays in that place, which says
// so and can try again.

import { Component, type ReactNode } from 'react';
import { Icon } from '../../../components';

export class SiteBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('A website on the board failed to show:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { onClose } = this.props;
    return (
      <div className={`site-failed nodrag${onClose ? ' is-full' : ''}`} role="alert">
        <p>This website couldn't be shown here.</p>
        <div className="row">
          <button className="btn btn-small" onClick={() => this.setState({ failed: false })}>
            Try again
          </button>
          {onClose && (
            <button className="btn btn-small btn-quiet" onClick={onClose}>
              <Icon name="x" /> Close
            </button>
          )}
        </div>
      </div>
    );
  }
}

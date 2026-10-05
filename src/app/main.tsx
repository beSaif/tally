import { render } from 'preact';
import './styles/tokens.css';

// TODO(frontend-agent): replace with the real <App/> (router, auth gate, screens).
function Placeholder() {
  return (
    <main class="screen">
      <div class="topline">
        <span class="wordmark">Tally</span>
        <span>Scaffold</span>
      </div>
      <p style="margin-top:20px" class="lead">
        Frontend not implemented yet.
      </p>
    </main>
  );
}

render(<Placeholder />, document.getElementById('app')!);

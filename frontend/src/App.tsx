import { Link, Route, Routes } from 'react-router-dom';

const Home = () => (
  <main className="shell">
    <section className="card hero">
      <p className="eyebrow">Procurement and payment</p>
      <h1>Farmers Payment App</h1>
      <p>
        Offline-first purchase capture with price board, OCR-assisted entry, and manager review.
      </p>
      <div className="actions">
        <Link to="/login" className="button primary">
          Open login
        </Link>
        <Link to="/purchases" className="button secondary">
          View purchases
        </Link>
      </div>
    </section>
  </main>
);

const Login = () => (
  <main className="shell narrow">
    <section className="card">
      <h2>Login</h2>
      <form className="stack">
        <label>
          Email
          <input defaultValue="operator@demo.in" />
        </label>
        <label>
          Password
          <input type="password" defaultValue="demo123" />
        </label>
        <button type="button" className="button primary full-width">
          Sign in
        </button>
      </form>
    </section>
  </main>
);

const Purchases = () => (
  <main className="shell">
    <section className="card">
      <h2>Purchases</h2>
      <ul className="list">
        <li>Sunil Jadhav - Soybean - 1232.0 kg - ₹59,752.00</li>
        <li>Kamal Shinde - Soybean - 831.0 kg - ₹40,303.50</li>
        <li>Mohan Biradar - Tur - 630.0 kg - ₹45,360.00</li>
      </ul>
    </section>
  </main>
);

export default function App() {
  return (
    <div>
      <nav className="topbar">
        <Link to="/">Home</Link>
        <Link to="/login">Login</Link>
        <Link to="/purchases">Purchases</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/purchases" element={<Purchases />} />
      </Routes>
    </div>
  );
}

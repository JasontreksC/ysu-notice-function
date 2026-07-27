export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>YSU Notice Function</h1>
      <p>API endpoints:</p>
      <ul>
        <li>
          <code>GET /api/notice</code>
        </li>
        <li>
          <code>POST /api/subscription</code>
        </li>
      </ul>
    </main>
  );
}

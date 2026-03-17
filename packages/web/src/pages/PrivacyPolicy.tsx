import "./PrivacyPolicy.css";

const LAST_UPDATED = "March 17, 2026";

export default function PrivacyPolicy() {
  return (
    <main className="privacy-page">
      <section className="privacy-hero">
        <p className="privacy-eyebrow">Screenshot Privacy Policy</p>
        <h1>Privacy Policy</h1>
        <p className="privacy-summary">
          Screenshot lets users capture screenshots and recordings, review them,
          and optionally upload them for sharing. This page explains what data
          the product handles and how it is used.
        </p>
        <p className="privacy-updated">Last updated: {LAST_UPDATED}</p>
      </section>

      <section className="privacy-card">
        <h2>Information We Collect</h2>
        <p>
          Screenshot may process the following information when a user chooses
          to use the extension or website:
        </p>
        <ul>
          <li>Account information such as name, email address, and profile image.</li>
          <li>Authentication and session information required to keep users signed in.</li>
          <li>Screenshots and screen recordings created by the user.</li>
          <li>Page URL associated with a capture.</li>
          <li>Optional console logs and network logs collected for a capture.</li>
          <li>Device and browser metadata related to a capture.</li>
          <li>Local preferences and temporary capture state stored in the browser.</li>
        </ul>
      </section>

      <section className="privacy-card">
        <h2>How We Use Information</h2>
        <ul>
          <li>To authenticate users and keep their account session active.</li>
          <li>To save, display, edit, and share captures created by the user.</li>
          <li>To support debugging and inspection features when console or network capture is enabled.</li>
          <li>To improve product reliability, security, and performance.</li>
        </ul>
      </section>

      <section className="privacy-card">
        <h2>When Data Is Collected</h2>
        <p>
          Screenshot collects data only when the user interacts with the
          product, such as signing in, taking a screenshot, recording, opening
          the library, or choosing to upload a capture.
        </p>
      </section>

      <section className="privacy-card">
        <h2>Sharing and Storage</h2>
        <p>
          Captures and related metadata may be stored locally in the browser and
          may also be uploaded to our backend infrastructure when the user
          chooses to share or save them to their library.
        </p>
        <p>
          We do not sell user data. We use third-party service providers for
          authentication and storage, including Clerk for authentication and
          Convex for application data and file storage.
        </p>
      </section>

      <section className="privacy-card">
        <h2>User Controls</h2>
        <ul>
          <li>Users can choose whether to sign in.</li>
          <li>Users can choose whether to create a capture.</li>
          <li>Users can choose whether to enable network and console capture.</li>
          <li>Users can delete captures from their library.</li>
        </ul>
      </section>

      <section className="privacy-card">
        <h2>Retention</h2>
        <p>
          Temporary local captures are periodically cleaned up by the extension.
          Uploaded captures may also be removed automatically based on product
          retention rules.
        </p>
      </section>

      <section className="privacy-card">
        <h2>Contact</h2>
        <p>
          For privacy questions or deletion requests, contact:
          {" "}
          <a href="mailto:privacy@nachli.com">privacy@nachli.com</a>
        </p>
      </section>
    </main>
  );
}

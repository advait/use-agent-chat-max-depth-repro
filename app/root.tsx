import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  let title = "Error";
  let message = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = String(error.status);
    message = error.statusText || message;
  } else if (error instanceof Error) {
    message = error.message;
    stack = error.stack;
  }

  return (
    <main className="page">
      <section className="panel">
        <h1>{title}</h1>
        <p>{message}</p>
        {stack ? <pre>{stack}</pre> : null}
      </section>
    </main>
  );
}

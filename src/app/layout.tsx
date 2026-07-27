import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "YSU Notice Function",
  description: "Yeonsung University notice notification API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

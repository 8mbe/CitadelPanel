import { YourServers } from "@/components/your-servers";

export const metadata = { title: "Your servers" };

/**
 * The user home screen. Data loading lives in the client component, which
 * fetches the caller's servers from the backend.
 */
export default function ServersPage() {
  return <YourServers />;
}

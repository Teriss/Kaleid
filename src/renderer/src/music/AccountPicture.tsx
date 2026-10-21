import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";

/** Folia's account picture shape, served through Kaleid's restricted resource protocol. */
export default function AccountPicture({
  user,
  providerId,
  size = 44,
}: {
  user?: any;
  providerId: string;
  size?: number;
}) {
  const remote = user?.avatarUrl ?? user?.avatar ?? user?.profile?.avatarUrl;
  const [source, setSource] = useState("");
  useEffect(() => {
    let live = true;
    setSource("");
    if (typeof remote === "string" && remote)
      void window.music
        .resource(providerId, remote)
        .then((url) => {
          if (live) setSource(url);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [remote, providerId]);
  return (
    <span className="account-picture" style={{ width: size, height: size }}>
      {source ? (
        <img
          src={source}
          alt=""
          draggable={false}
          onError={() => setSource("")}
        />
      ) : user?.nickname ? (
        <span>{[...user.nickname.trim()][0]}</span>
      ) : (
        <UserRound size={size * 0.55} />
      )}
    </span>
  );
}

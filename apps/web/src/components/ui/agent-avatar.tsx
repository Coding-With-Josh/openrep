import { createAvatar } from '@dicebear/core';
import { bottts } from '@dicebear/collection';

type AgentAvatarProps = {
  name: string;
  seed?: string;
  className?: string;
};

const AgentAvatar = ({ name, seed, className }: AgentAvatarProps) => {
  const avatar = createAvatar(bottts, { seed: seed ?? name }).toDataUri();
  return <img src={avatar} alt={`avatar for ${name}`} className={className} />;
};

export default AgentAvatar;
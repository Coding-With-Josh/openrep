import { createAvatar } from '@dicebear/core';
import { bottts } from '@dicebear/collection';

type AgentAvatarProps = {
  name: string;
  className?: string;
};

const AgentAvatar = ({ name, className }: AgentAvatarProps) => {
  const avatar = createAvatar(bottts, { seed: name }).toDataUri();
  return <img src={avatar} alt={`avatar for ${name}`} className={className} />;
};

export default AgentAvatar;
import React from "react";
import { PixelHeading } from "../effects/pixel";
import {
  ArrowUpRightIcon,
  MessageCircle,
  MessageCircleCodeIcon,
  Play,
} from "lucide-react";
import {
  DitherImage,
  DitherImageCaption,
  DitherImageContent,
  DitherImageFrame,
  DitherImageOverlay,
  DitherImageReveal,
} from "@/components/effects/dither";
import Link from "next/link";

export const Intro = () => {
  return (
    <div className="flex flex-col items-center justify-center gap-2 z-1">
      <PixelHeading
        initialFont="square"
        hoverFont="line"
        className="text-8xl lg:text-9xl"
      >
        openrep
      </PixelHeading>
      <p className="text-md lg:text-xl tracking-[-0.02em] font-sans">
        Platform-agnostic Reputation Layer for AI Agents.
      </p>
      <div className="flex items-center justify-center gap-4 mt-6">
        <Link href="/agents">
          <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-white bg-black rounded-full hover:scale-102 active:scale-98 transition-all dark:transition-all dark:bg-white dark:text-black">
            <ArrowUpRightIcon className="w-4 h-4" />
            <span>launch an agent</span>
          </button>
        </Link>
        <Link href="/">
          <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-black bg-black/10 rounded-full hover:scale-102 active:scale-98 transition-all dark:transition-all dark:text-white dark:bg-white/10">
            <Play className="w-4 h-4" />
            <span>watch demo</span>
          </button>
        </Link>
      </div>
      <a
        href="https://chat.whatsapp.com/BGIAEvn9xPJIfEHz0ddv9E"
        target="_blank"
        rel="noopener noreferrer"
      >
        <button className="group flex items-center mt-4 justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 cursor-pointer hover:font-medium text-neutral-500 underline underline-offset-4 hover:text-black rounded-full hover:scale-102 active:scale-98 transition-all dark:text-neutral-300 dark:border-white/15">
          <MessageCircleCodeIcon className="w-4 h-4 group-hover:stroke-[2.5]" />
          <span>join whatsapp group for new feature releases</span>
          <ArrowUpRightIcon className="w-4 h-4 -ml-1.5 transition-transform group-hover:translate-x-0.5 group-hover:stroke-[2.5]" />
        </button>
      </a>
    </div>
  );
};

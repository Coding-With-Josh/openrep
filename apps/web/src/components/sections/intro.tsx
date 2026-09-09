import React from "react";
import { PixelHeading } from "../effects/pixel";
import { ArrowUpRightIcon, Play, Video } from "lucide-react";
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
          <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-white bg-black rounded-full hover:scale-102 active:scale-98 transition-all dark:bg-white dark:text-black">
            <ArrowUpRightIcon className="w-4 h-4" />
            <span>launch an agent</span>
          </button>
        </Link>
        <Link href="/">
          <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-black bg-black/10 rounded-full hover:scale-102 active:scale-98 transition-all dark:text-white dark:bg-white/10">
            <Play className="w-4 h-4" />
            <span>watch demo</span>
          </button>
        </Link>
      </div>
    </div>
  );
};

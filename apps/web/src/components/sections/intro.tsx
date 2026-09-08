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
    <div className="flex flex-col items-center justify-center gap-3 z-1">
      <PixelHeading initialFont="square" hoverFont="line" className="text-9xl">
        openrep
      </PixelHeading>
      <h1 className="text-xl tracking-[-0.02em] font-sans">
        Platform-agnostic Reputation Layer for AI Agents.
      </h1>
      <div className="flex items-center justify-center gap-4 mt-6">
        <Link href="/agents">
          <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-white bg-black rounded-full hover:scale-102 active:scale-98 transition-all">
            <ArrowUpRightIcon className="w-4 h-4" />
            <h1>launch an agent</h1>
          </button>
        </Link>
        <Link href="/">
          <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-black bg-black/10 rounded-full hover:scale-102 active:scale-98 transition-all">
            <Play className="w-4 h-4" />
            <h1>watch demo</h1>
          </button>
        </Link>
      </div>
    </div>
  );
};

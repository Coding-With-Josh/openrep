import Link from "next/link";
import { Home } from "lucide-react";
import { PixelHeading } from "@/components/effects/pixel";

export default function NotFound() {
  return (
    <div className="bg-white text-black w-screen min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center justify-center gap-3 z-1">
        <PixelHeading
          as="span"
          initialFont="square"
          hoverFont="line"
          className="text-9xl"
        >
          404
        </PixelHeading>
        <h1 className="text-xl tracking-[-0.02em] font-sans">
          this page does not exist.
        </h1>
        <div className="flex items-center justify-center gap-4 mt-6">
          <Link href="/">
            <button className="flex items-center justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-white bg-black rounded-full hover:scale-102 active:scale-98 transition-all">
              <Home className="w-4 h-4" />
              <span>go to home</span>
            </button>
          </Link>
        </div>
      </div>
    </div>
  );
}
